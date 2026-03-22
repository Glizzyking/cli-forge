'use strict';

const https  = require('https');
const http   = require('http');
const { randomUUID } = require('crypto');

const ROOT_FRAME = '00000000-0000-0000-0000-000000000000';

// ─── Transit+JSON encoder (minimal subset for Penpot update-file) ─────────────
const kw  = (s) => `~:${s}`;
const uid = (s) => `~u${s}`;

function tEnc(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(tEnc);
  // Plain object → Transit cacheable map
  const arr = ['^ '];
  for (const [k, val] of Object.entries(v)) arr.push(k, tEnc(val));
  return arr;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function parseRes(raw, status, method, path) {
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (status >= 400) throw Object.assign(
    new Error(`Penpot ${status} ${method} ${path}: ${raw.slice(0, 300)}`),
    { status, body: data }
  );
  return data;
}

async function req(baseUrl, method, path, body, cookie) {
  const u   = new URL(path, baseUrl);
  const mod = u.protocol === 'https:' ? https : http;
  const str = body != null ? JSON.stringify(body) : null;
  const hdrs = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (str)    hdrs['Content-Length'] = Buffer.byteLength(str);
  if (cookie) hdrs['Cookie'] = cookie;

  return new Promise((resolve, reject) => {
    const r = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method, headers: hdrs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw   = Buffer.concat(chunks).toString();
          const setCk = res.headers['set-cookie'];
          const ck    = setCk?.map(s => s.split(';')[0]).join('; ') || null;
          try { resolve({ data: parseRes(raw, res.statusCode, method, path), cookie: ck }); }
          catch (e) { reject(e); }
        });
      }
    );
    r.on('error', reject);
    if (str) r.write(str);
    r.end();
  });
}

async function reqTransit(baseUrl, method, path, body, cookie) {
  const u   = new URL(path, baseUrl);
  const mod = u.protocol === 'https:' ? https : http;
  const str = JSON.stringify(body);
  const hdrs = {
    'Content-Type':  'application/transit+json',
    'Accept':        'application/transit+json',
    'Content-Length': Buffer.byteLength(str),
  };
  if (cookie) hdrs['Cookie'] = cookie;

  return new Promise((resolve, reject) => {
    const r = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method, headers: hdrs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ data: parseRes(raw, res.statusCode, method, path) }); }
          catch (e) { reject(e); }
        });
      }
    );
    r.on('error', reject);
    r.write(str);
    r.end();
  });
}

async function upload(baseUrl, path, fields, fileBuf, fileName, mtype, cookie) {
  const boundary = `Boundary${randomUUID().replace(/-/g, '')}`;
  const u   = new URL(path, baseUrl);
  const mod = u.protocol === 'https:' ? https : http;

  const parts = [];
  for (const [name, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${fileName}"\r\nContent-Type: ${mtype}\r\n\r\n`));
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const bodyBuf = Buffer.concat(parts);
  const hdrs = {
    'Content-Type':   `multipart/form-data; boundary=${boundary}`,
    'Content-Length': bodyBuf.length,
    'Accept':         'application/json',
  };
  if (cookie) hdrs['Cookie'] = cookie;

  return new Promise((resolve, reject) => {
    const r = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname, method: 'POST', headers: hdrs },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try { resolve({ data: parseRes(raw, res.statusCode, 'POST', path) }); }
          catch (e) { reject(e); }
        });
      }
    );
    r.on('error', reject);
    r.write(bodyBuf);
    r.end();
  });
}

async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302)
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      const mtype  = res.headers['content-type'] || 'image/jpeg';
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), mtype }));
    }).on('error', reject);
  });
}

// ─── Penpot REST API ──────────────────────────────────────────────────────────
async function login(baseUrl, email, password) {
  const { data, cookie } = await req(baseUrl, 'POST', '/api/rpc/command/login-with-password',
    { email, password });
  if (!cookie) throw new Error('Penpot login failed — no session cookie returned');
  return { userId: data.id, cookie };
}

async function getTeams(baseUrl, cookie) {
  const { data } = await req(baseUrl, 'GET', '/api/rpc/command/get-teams', null, cookie);
  return Array.isArray(data) ? data : [data];
}

async function getProjects(baseUrl, cookie, teamId) {
  const { data } = await req(baseUrl, 'GET',
    `/api/rpc/command/get-projects?team-id=${teamId}`, null, cookie);
  return Array.isArray(data) ? data : [];
}

async function createProject(baseUrl, cookie, teamId, name) {
  const { data } = await req(baseUrl, 'POST', '/api/rpc/command/create-project',
    { 'team-id': teamId, name }, cookie);
  return data;
}

async function createFile(baseUrl, cookie, projectId, name) {
  const { data } = await req(baseUrl, 'POST', '/api/rpc/command/create-file',
    { 'project-id': projectId, name, 'is-shared': false }, cookie);
  return data;
}

async function uploadMedia(baseUrl, cookie, fileId, imgBuf, name, mtype) {
  const { data } = await upload(baseUrl,
    '/api/rpc/command/upload-file-media-object',
    { 'file-id': fileId, name, 'is-local': 'true' },
    imgBuf, name, mtype, cookie);
  return data;
}

async function updateFile(baseUrl, cookie, fileId, revn, changes) {
  const sessionId = randomUUID();
  const transitBody = tEnc({
    [kw('id')]:         uid(fileId),
    [kw('revn')]:       revn,
    [kw('session-id')]: uid(sessionId),
    [kw('changes')]:    changes,
  });

  try {
    const { data } = await reqTransit(baseUrl, 'PUT',
      '/api/rpc/command/update-file', transitBody, cookie);
    return data;
  } catch (e) {
    // fallback: plain JSON with kebab-case keys
    const plainChanges = changes.map(transitArrayToObj);
    const { data } = await req(baseUrl, 'PUT', '/api/rpc/command/update-file',
      { id: fileId, revn, 'session-id': sessionId, changes: plainChanges }, cookie);
    return data;
  }
}

function transitArrayToObj(arr) {
  if (!Array.isArray(arr) || arr[0] !== '^ ') return arr;
  const obj = {};
  for (let i = 1; i < arr.length; i += 2) {
    const k = String(arr[i]).replace(/^~:/, '');
    const v = arr[i + 1];
    obj[k] = Array.isArray(v) && v[0] === '^ ' ? transitArrayToObj(v)
           : typeof v === 'string' && v.startsWith('~:') ? v.slice(2)
           : typeof v === 'string' && v.startsWith('~u') ? v.slice(2)
           : Array.isArray(v) ? v.map(x => Array.isArray(x) && x[0] === '^ ' ? transitArrayToObj(x) : x)
           : v;
  }
  return obj;
}

async function createShareLink(baseUrl, cookie, fileId, pageId) {
  const { data } = await req(baseUrl, 'POST', '/api/rpc/command/create-share-link',
    { 'file-id': fileId, 'page-id': pageId }, cookie);
  return data;
}

// ─── Shape change builders ────────────────────────────────────────────────────
function changeFrame(frameId, pageId, name, x, y, w, h) {
  return tEnc({
    [kw('type')]:      kw('add-obj'),
    [kw('id')]:        uid(frameId),
    [kw('page-id')]:   uid(pageId),
    [kw('frame-id')]:  uid(ROOT_FRAME),
    [kw('parent-id')]: uid(ROOT_FRAME),
    [kw('obj')]: {
      [kw('id')]:        uid(frameId),
      [kw('type')]:      kw('frame'),
      [kw('name')]:      name,
      [kw('x')]:         x,
      [kw('y')]:         y,
      [kw('width')]:     w,
      [kw('height')]:    h,
      [kw('rotation')]:  0,
      [kw('fills')]:     [],
      [kw('strokes')]:   [],
      [kw('shapes')]:    [],
      [kw('frame-id')]:  uid(ROOT_FRAME),
      [kw('parent-id')]: uid(ROOT_FRAME),
    },
  });
}

function changeImage(imgId, frameId, pageId, mediaId, w, h, mtype) {
  return tEnc({
    [kw('type')]:      kw('add-obj'),
    [kw('id')]:        uid(imgId),
    [kw('page-id')]:   uid(pageId),
    [kw('frame-id')]:  uid(frameId),
    [kw('parent-id')]: uid(frameId),
    [kw('obj')]: {
      [kw('id')]:        uid(imgId),
      [kw('type')]:      kw('image'),
      [kw('name')]:      'background',
      [kw('x')]:         0,
      [kw('y')]:         0,
      [kw('width')]:     w,
      [kw('height')]:    h,
      [kw('rotation')]:  0,
      [kw('fills')]:     [],
      [kw('strokes')]:   [],
      [kw('metadata')]: {
        [kw('id')]:    uid(mediaId),
        [kw('width')]: w,
        [kw('height')]: h,
        [kw('mtype')]: mtype,
      },
      [kw('frame-id')]:  uid(frameId),
      [kw('parent-id')]: uid(frameId),
    },
  });
}

function changeText(textId, frameId, pageId, text, y, w, h, fontSize) {
  return tEnc({
    [kw('type')]:      kw('add-obj'),
    [kw('id')]:        uid(textId),
    [kw('page-id')]:   uid(pageId),
    [kw('frame-id')]:  uid(frameId),
    [kw('parent-id')]: uid(frameId),
    [kw('obj')]: {
      [kw('id')]:       uid(textId),
      [kw('type')]:     kw('text'),
      [kw('name')]:     'text-overlay',
      [kw('x')]:        80,
      [kw('y')]:        y,
      [kw('width')]:    w,
      [kw('height')]:   h,
      [kw('rotation')]: 0,
      [kw('fills')]:    [],
      [kw('strokes')]:  [],
      [kw('content')]: {
        [kw('type')]: kw('root'),
        [kw('children')]: [{
          [kw('type')]: kw('paragraph-set'),
          [kw('children')]: [{
            [kw('type')]:  kw('paragraph'),
            [kw('align')]: kw('center'),
            [kw('children')]: [{
              [kw('type')]:        kw('text'),
              [kw('text')]:        text,
              [kw('font-size')]:   String(fontSize),
              [kw('font-family')]: 'Inter',
              [kw('font-weight')]: '700',
              [kw('fills')]: [{
                [kw('fill-color')]:   '#ffffff',
                [kw('fill-opacity')]: 1,
              }],
            }],
          }],
        }],
      },
      [kw('frame-id')]:  uid(frameId),
      [kw('parent-id')]: uid(frameId),
    },
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function buildMockup(config, post) {
  const baseUrl = (config.penpotUrl || 'https://design.penpot.app').replace(/\/$/, '');

  // 1. Auth
  const { cookie } = await login(baseUrl, config.penpotEmail, config.penpotPassword);

  // 2. Team → use first non-default or default team
  const teams  = await getTeams(baseUrl, cookie);
  const team   = teams.find(t => !t['is-default']) || teams[0];
  if (!team) throw new Error('No Penpot teams found');

  // 3. Project — reuse or create
  const projects  = await getProjects(baseUrl, cookie, team.id);
  let   project   = projects.find(p => p.name === 'Larry Post Mockups');
  if (!project)   project = await createProject(baseUrl, cookie, team.id, 'Larry Post Mockups');

  // 4. Create file
  const date     = new Date(post.createdAt || Date.now()).toLocaleDateString();
  const fileData = await createFile(baseUrl, cookie, project.id, `Carousel — ${date}`);
  const fileId   = fileData.id;
  const revn     = fileData.revn ?? 0;

  // Extract page ID from file data (might be plain JSON or Transit-decoded)
  let pageId = fileData.data?.pages?.[0]
            || fileData['~:data']?.['~:pages']?.[0]?.replace?.(/^~u/, '');
  if (!pageId) throw new Error('Could not read page ID from new file response. Check Penpot version compatibility.');

  // 5. Upload each slide image + build changes
  const changes = [];
  const W = 1024, H = 1536, GAP = 80;

  for (let i = 0; i < post.slides.length; i++) {
    const slide  = post.slides[i];
    const imgUrl = slide.imageUrl || post.imageUrls?.[i];
    if (!imgUrl) continue;

    const { buffer, mtype } = await downloadImage(imgUrl);
    const media = await uploadMedia(baseUrl, cookie, fileId, buffer, `slide-${i + 1}.jpg`, mtype);

    const frameId = randomUUID();
    const imgId   = randomUUID();
    const textId  = randomUUID();
    const x       = i * (W + GAP);
    const fontSize = (slide.text?.length || 0) > 20 ? 60 : (slide.text?.length || 0) > 12 ? 72 : 80;
    const textY   = Math.round(H * 0.22);

    changes.push(changeFrame(frameId, pageId, `Slide ${i + 1}`, x, 0, W, H));
    changes.push(changeImage(imgId, frameId, pageId, media.id, W, H, media.mtype || mtype));
    changes.push(changeText(textId, frameId, pageId, slide.text || '', textY, W - 160, 320, fontSize));
  }

  if (changes.length === 0) throw new Error('No slide images to upload');

  // 6. Write all shapes
  await updateFile(baseUrl, cookie, fileId, revn, changes);

  // 7. Share link
  const share    = await createShareLink(baseUrl, cookie, fileId, pageId);
  const shareId  = share.id || share.token;
  const shareUrl = `${baseUrl}/view/${fileId}/${pageId}?share-id=${shareId}`;

  return { url: shareUrl, fileId, pageId, shareId };
}

module.exports = { buildMockup };
