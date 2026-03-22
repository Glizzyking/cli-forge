#!/usr/bin/env node
/**
 * analytics — TikTok analytics CLI for larry-cli
 *
 * Each TikTok account gets its own data file:
 *   ~/.larry-cli/accounts/<account>/analytics.json
 *
 * Commands:
 *   node analytics.js auth [account]          Re-authorize with analytics scopes
 *   node analytics.js fetch [account | --all] Pull latest data from TikTok
 *   node analytics.js stats [account]         Account overview (followers, totals)
 *   node analytics.js videos [account]        All videos with metrics table
 *   node analytics.js top [account] [--n 10]  Top N videos by views
 *   node analytics.js compare                 Side-by-side comparison of all accounts
 *   node analytics.js export [account]        Export to CSV
 *   node analytics.js accounts                List all authorized accounts
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");
const { execSync } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), ".larry-cli");
const CONFIG_FILE = path.join(CONFIG_DIR,  "config.json");
const ACCOUNTS_DIR = path.join(CONFIG_DIR, "accounts");

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", blue: "\x1b[34m", magenta: "\x1b[35m",
};
const log = {
  info:  (m) => process.stderr.write(`${c.cyan}[analytics]${c.reset} ${m}\n`),
  ok:    (m) => process.stderr.write(`${c.green}[✓]${c.reset} ${m}\n`),
  warn:  (m) => process.stderr.write(`${c.yellow}[!]${c.reset} ${m}\n`),
  err:   (m) => process.stderr.write(`${c.red}[✗]${c.reset} ${m}\n`),
  step:  (m) => process.stderr.write(`${c.blue}[→]${c.reset} ${m}\n`),
};
function die(msg) { log.err(msg); process.exit(1); }

// ─── Config helpers ───────────────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) die("larry-cli not initialized. Run: node larry.js init");
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ─── Per-account analytics storage ───────────────────────────────────────────
function accountDir(name) {
  return path.join(ACCOUNTS_DIR, name);
}
function analyticsFile(name) {
  return path.join(accountDir(name), "analytics.json");
}
function loadAnalytics(name) {
  const f = analyticsFile(name);
  if (!fs.existsSync(f)) return { account: name, profile: null, videos: [], history: [], lastFetched: null };
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return { account: name, profile: null, videos: [], history: [], lastFetched: null }; }
}
function saveAnalytics(name, data) {
  const dir = accountDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(analyticsFile(name), JSON.stringify(data, null, 2));
}
function listAccounts() {
  const cfg      = loadConfig();
  const fromCfg  = Object.keys(cfg.tokens || {});
  const fromDirs = fs.existsSync(ACCOUNTS_DIR)
    ? fs.readdirSync(ACCOUNTS_DIR).filter(d => fs.statSync(path.join(ACCOUNTS_DIR, d)).isDirectory())
    : [];
  return [...new Set([...fromCfg, ...fromDirs])];
}

// ─── Token management (mirrors larry.js) ─────────────────────────────────────
const TIKTOK_BASE    = "https://open.tiktokapis.com";
const OAUTH_CALLBACK = "http://localhost:8347/callback";
const OAUTH_PORT     = 8347;

// Scopes: existing larry scopes + analytics-specific ones
const ANALYTICS_SCOPES = [
  "video.publish",
  "video.upload",
  "video.list",
  "user.info.basic",
  "user.info.profile",
  "user.info.stats",
].join(",");

async function refreshToken(clientKey, clientSecret, refreshTok) {
  const res = await fetch(`${TIKTOK_BASE}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: refreshTok,
    }).toString(),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Token refresh failed: ${t}`); }
  return res.json();
}

async function getValidToken(cfg, accountName) {
  const td = (cfg.tokens || {})[accountName];
  if (!td) throw new Error(`No token for "${accountName}". Run: node analytics.js auth ${accountName}`);

  if (Date.now() > (td.expires_at - 300000)) {
    log.step(`Refreshing token for "${accountName}"...`);
    const nt = await refreshToken(cfg.tiktokClientKey, cfg.tiktokClientSecret, td.refresh_token);
    td.access_token  = nt.access_token;
    td.refresh_token = nt.refresh_token || td.refresh_token;
    td.expires_at    = Date.now() + (nt.expires_in * 1000);
    cfg.tokens[accountName] = td;
    saveConfig(cfg);
    log.ok("Token refreshed");
  }
  return td.access_token;
}

// ─── TikTok API calls ─────────────────────────────────────────────────────────
async function fetchUserInfo(token) {
  const fields = [
    "open_id", "union_id", "display_name", "avatar_url",
    "bio_description", "profile_deep_link", "is_verified",
    "follower_count", "following_count", "likes_count", "video_count",
  ].join(",");

  const res = await fetch(`${TIKTOK_BASE}/v2/user/info/?fields=${fields}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`user/info failed ${res.status}: ${t}`);
  }
  const body = await res.json();
  if (body.error?.code && body.error.code !== "ok") {
    throw new Error(`TikTok error: ${body.error.message || JSON.stringify(body.error)}`);
  }
  return body.data?.user || body.data || {};
}

async function fetchAllVideos(token) {
  const fields = [
    "id", "title", "video_description", "create_time",
    "cover_image_url", "share_url", "duration",
    "view_count", "like_count", "comment_count", "share_count",
    "embed_link",
  ].join(",");

  const videos = [];
  let cursor   = 0;
  let hasMore  = true;
  let page     = 1;

  while (hasMore) {
    log.step(`  Fetching videos page ${page} (cursor: ${cursor})...`);
    const url = `${TIKTOK_BASE}/v2/video/list/?fields=${fields}&cursor=${cursor}&max_count=20`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`video/list failed ${res.status}: ${t}`);
    }

    const body = await res.json();
    if (body.error?.code && body.error.code !== "ok") {
      // If video.list scope is missing, warn and break
      if (body.error.code === "access_token_invalid" || body.error.code === "scope_not_authorized") {
        log.warn(`video.list scope not available — re-auth with: node analytics.js auth`);
        break;
      }
      throw new Error(`TikTok error: ${body.error.message}`);
    }

    const batch = body.data?.videos || [];
    videos.push(...batch);
    hasMore = body.data?.has_more ?? false;
    cursor  = body.data?.cursor  ?? 0;
    page++;

    if (!hasMore || batch.length === 0) break;
  }

  return videos;
}

// Resolve a larry publishId → TikTok video_id via publish status endpoint
async function fetchPublishStatus(token, publishId) {
  const res = await fetch(
    `${TIKTOK_BASE}/v2/post/publish/status/fetch/?publish_id=${encodeURIComponent(publishId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`publish/status failed ${res.status}: ${t}`);
  }
  const body = await res.json();
  if (body.error?.code && body.error.code !== "ok") {
    throw new Error(`publish/status error: ${body.error.message}`);
  }
  // status: PROCESSING_DOWNLOAD | PROCESSING_UPLOAD | PUBLISH_COMPLETE | FAILED
  return {
    status:  body.data?.status   || "UNKNOWN",
    videoId: body.data?.video_id ? String(body.data.video_id) : null,
  };
}

// Fetch stats for specific video IDs via video/query
async function fetchVideosByIds(token, videoIds) {
  if (!videoIds.length) return [];
  const fields = [
    "id", "title", "video_description", "create_time",
    "cover_image_url", "share_url", "duration",
    "view_count", "like_count", "comment_count", "share_count",
    "embed_link",
  ].join(",");

  const res = await fetch(`${TIKTOK_BASE}/v2/video/query/?fields=${fields}`, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ filters: { video_ids: videoIds } }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`video/query failed ${res.status}: ${t}`);
  }
  const body = await res.json();
  if (body.error?.code && body.error.code !== "ok") {
    throw new Error(`video/query error: ${body.error.message}`);
  }
  return body.data?.videos || [];
}

// larry db path (same dir as config)
const DB_FILE = path.join(CONFIG_DIR, "db.json");
function loadLarryDB() {
  if (!fs.existsSync(DB_FILE)) return { tiktoks: [], posts: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return { tiktoks: [], posts: [] }; }
}
function saveLarryDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function normaliseVideo(v, fromLarry = false) {
  return {
    id:         String(v.id || ""),
    title:      v.title           || v.video_description || "",
    createTime: v.create_time     || 0,
    duration:   v.duration        || 0,
    views:      v.view_count      || 0,
    likes:      v.like_count      || 0,
    comments:   v.comment_count   || 0,
    shares:     v.share_count     || 0,
    shareUrl:   v.share_url       || "",
    coverUrl:   v.cover_image_url || "",
    embedLink:  v.embed_link      || "",
    ...(fromLarry ? { fromLarry: true } : {}),
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdAuth(args) {
  const cfg         = loadConfig();
  const accountName = args[0] || "default";

  if (!cfg.tiktokClientKey)    die("tiktokClientKey not set. Run: node larry.js init");
  if (!cfg.tiktokClientSecret) die("tiktokClientSecret not set. Run: node larry.js init");

  log.info(`Authorizing "${accountName}" with analytics scopes...`);
  log.info(`Scopes: ${ANALYTICS_SCOPES}`);

  const state   = Math.random().toString(36).slice(2);
  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${cfg.tiktokClientKey}&scope=${encodeURIComponent(ANALYTICS_SCOPES)}&response_type=code&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}&state=${state}`;

  console.log(`\n${c.bold}Open this URL in your browser:${c.reset}\n${c.cyan}${authUrl}${c.reset}\n`);
  const opener = process.platform === "win32" ? "start" :
                 process.platform === "darwin" ? "open" : "xdg-open";
  try { execSync(`${opener} "${authUrl}"`, { stdio: "ignore" }); } catch {}

  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u    = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      const code = u.searchParams.get("code");
      if (!code || u.searchParams.get("state") !== state) {
        res.writeHead(400); res.end("Bad request"); return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>✓ Analytics authorized! You can close this tab.</h2></body></html>");
      server.close();
      try {
        const tr = await fetch(`${TIKTOK_BASE}/v2/oauth/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key:    cfg.tiktokClientKey,
            client_secret: cfg.tiktokClientSecret,
            code,
            grant_type:    "authorization_code",
            redirect_uri:  OAUTH_CALLBACK,
          }).toString(),
        });
        if (!tr.ok) { const t = await tr.text(); return reject(new Error(`Token exchange: ${t}`)); }
        resolve(await tr.json());
      } catch (e) { reject(e); }
    });
    server.listen(OAUTH_PORT, () => log.info(`Waiting for OAuth callback on port ${OAUTH_PORT}...`));
    server.on("error", reject);
    setTimeout(() => { server.close(); reject(new Error("OAuth timeout (5 min)")); }, 300000);
  });

  cfg.tokens = cfg.tokens || {};
  cfg.tokens[accountName] = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    open_id:       tokens.open_id,
    expires_at:    Date.now() + (tokens.expires_in * 1000),
    scopes:        ANALYTICS_SCOPES,
  };
  saveConfig(cfg);
  log.ok(`Account "${accountName}" authorized with analytics scopes!`);
}

async function cmdFetch(args) {
  const cfg = loadConfig();
  let targets = [];

  if (args.includes("--all")) {
    targets = listAccounts();
    if (targets.length === 0) die("No accounts found. Run: node analytics.js auth");
  } else {
    targets = [args[0] || "default"];
  }

  for (const accountName of targets) {
    console.log(`\n${c.bold}Fetching analytics for: ${c.cyan}${accountName}${c.reset}`);

    let token;
    try { token = await getValidToken(cfg, accountName); }
    catch (e) { log.warn(e.message); continue; }

    const existing = loadAnalytics(accountName);

    // Fetch profile
    log.step("Fetching profile stats...");
    let profile = existing.profile;
    try {
      const raw = await fetchUserInfo(token);
      profile = {
        displayName:    raw.display_name   || "",
        openId:         raw.open_id        || "",
        avatarUrl:      raw.avatar_url     || "",
        bio:            raw.bio_description || "",
        verified:       raw.is_verified    || false,
        profileLink:    raw.profile_deep_link || "",
        followers:      raw.follower_count  || 0,
        following:      raw.following_count || 0,
        totalLikes:     raw.likes_count     || 0,
        videoCount:     raw.video_count     || 0,
      };
      log.ok(`Profile: ${profile.displayName || "unknown"} | Followers: ${fmt(profile.followers)}`);
    } catch (e) {
      log.warn(`Profile fetch failed: ${e.message}`);
    }

    // ── Step 1: video/list — all public videos ──
    log.step("Fetching all public videos (video/list)...");
    let videos = existing.videos;
    try {
      const raw = await fetchAllVideos(token);
      videos = raw.map(v => normaliseVideo(v));
      log.ok(`${videos.length} public videos fetched`);
    } catch (e) {
      log.warn(`video/list failed: ${e.message}`);
    }

    // ── Step 2: larry upload posts — resolve publishId → videoId → stats ──
    const larryDB    = loadLarryDB();
    const larryPosts = (larryDB.posts || []).filter(p => p.account === accountName || (!p.account && accountName === "default"));

    if (larryPosts.length) {
      log.step(`Checking ${larryPosts.length} larry upload post(s)...`);

      let dbDirty = false;
      const resolvedIds = [];

      for (const post of larryPosts) {
        if (!post.publishId) continue;

        // Already resolved in a previous fetch
        if (post.videoId) {
          resolvedIds.push(post.videoId);
          continue;
        }

        // Try to resolve publishId → videoId
        try {
          const { status, videoId } = await fetchPublishStatus(token, post.publishId);
          log.info(`  Post #${post.id}: status=${status}${videoId ? ", videoId=" + videoId : ""}`);

          if (videoId) {
            post.videoId = videoId;
            dbDirty = true;
            resolvedIds.push(videoId);
          } else if (status === "FAILED") {
            log.warn(`  Post #${post.id}: upload failed on TikTok`);
          } else {
            log.info(`  Post #${post.id}: still processing (${status}) — try again later`);
          }
        } catch (e) {
          log.warn(`  Publish status check failed for post #${post.id}: ${e.message}`);
        }
      }

      if (dbDirty) saveLarryDB(larryDB);

      // ── Step 3: video/query — fetch stats for resolved video IDs ──
      if (resolvedIds.length) {
        log.step(`Fetching stats for ${resolvedIds.length} larry video(s) via video/query...`);
        try {
          const queried = await fetchVideosByIds(token, resolvedIds);
          const queriedNorm = queried.map(v => normaliseVideo(v, true));

          // Merge into videos array: update if already present, add if new
          for (const qv of queriedNorm) {
            const idx = videos.findIndex(v => v.id === qv.id);
            if (idx >= 0) {
              videos[idx] = { ...videos[idx], ...qv, fromLarry: true };
            } else {
              videos.push(qv);
            }
          }
          log.ok(`${queriedNorm.length} larry video(s) merged`);
        } catch (e) {
          log.warn(`video/query failed: ${e.message}`);
        }
      }

      // Mark any videos in the list that match a larry post (even without query)
      for (const post of larryPosts) {
        if (!post.videoId) continue;
        const idx = videos.findIndex(v => v.id === post.videoId);
        if (idx >= 0) videos[idx].fromLarry = true;
      }
    }

    // Append to history
    const history = existing.history || [];
    if (profile) {
      history.push({
        fetchedAt:   new Date().toISOString(),
        followers:   profile.followers,
        totalLikes:  profile.totalLikes,
        videoCount:  profile.videoCount,
        totalViews:  videos.reduce((s, v) => s + v.views, 0),
      });
      if (history.length > 90) history.shift(); // keep 90 data points
    }

    const data = { account: accountName, profile, videos, history, lastFetched: new Date().toISOString() };
    saveAnalytics(accountName, data);
    log.ok(`Saved → ${analyticsFile(accountName)}`);
  }
}

async function cmdStats(args) {
  const accountName = args[0] || "default";
  const data = loadAnalytics(accountName);

  if (!data.profile && !data.videos.length) {
    die(`No data for "${accountName}". Run: node analytics.js fetch ${accountName}`);
  }

  const p      = data.profile || {};
  const videos = data.videos || [];
  const totalViews    = videos.reduce((s, v) => s + v.views,    0);
  const totalLikes    = videos.reduce((s, v) => s + v.likes,    0);
  const totalComments = videos.reduce((s, v) => s + v.comments, 0);
  const totalShares   = videos.reduce((s, v) => s + v.shares,   0);
  const avgViews      = videos.length ? Math.round(totalViews / videos.length) : 0;
  const topVideo      = [...videos].sort((a, b) => b.views - a.views)[0];

  console.log(`\n${c.bold}${c.cyan}━━ ${accountName} ━━${c.reset}`);
  if (p.displayName) console.log(`  ${c.bold}${p.displayName}${c.reset}${p.verified ? " ✓" : ""}`);
  if (p.bio)         console.log(`  ${c.dim}${p.bio}${c.reset}`);
  console.log();

  const row = (label, val, sub) =>
    console.log(`  ${c.dim}${label.padEnd(18)}${c.reset}${c.bold}${val}${c.reset}${sub ? c.dim + "  " + sub + c.reset : ""}`);

  row("Followers",   fmt(p.followers   || 0));
  row("Following",   fmt(p.following   || 0));
  row("Total likes", fmt(p.totalLikes  || totalLikes));
  row("Videos",      fmt(p.videoCount  || videos.length));
  console.log(`  ${c.dim}${"─".repeat(36)}${c.reset}`);
  row("Total views",    fmt(totalViews),    `across ${videos.length} tracked videos`);
  row("Total likes",    fmt(totalLikes));
  row("Total comments", fmt(totalComments));
  row("Total shares",   fmt(totalShares));
  row("Avg views/video", fmt(avgViews));
  if (topVideo) {
    console.log();
    row("Top video", fmt(topVideo.views) + " views", topVideo.title?.slice(0, 50) || topVideo.id);
  }

  if (data.history?.length > 1) {
    const first = data.history[0];
    const last  = data.history[data.history.length - 1];
    const growth = last.followers - first.followers;
    console.log(`\n  ${c.dim}Follower growth since first fetch: ${growth >= 0 ? c.green : c.red}${growth >= 0 ? "+" : ""}${fmt(growth)}${c.reset}`);
  }

  if (data.lastFetched) {
    console.log(`\n  ${c.dim}Last fetched: ${new Date(data.lastFetched).toLocaleString()}${c.reset}`);
  }
}

async function cmdVideos(args) {
  let sort   = "views";
  let acct   = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sort" || args[i] === "-s") sort = args[++i];
    else if (!acct) acct = args[i];
  }
  const accountName = acct || "default";
  const data   = loadAnalytics(accountName);
  const videos = data.videos || [];

  if (!videos.length) die(`No video data for "${accountName}". Run: node analytics.js fetch`);

  const sortKey = { views: "views", likes: "likes", comments: "comments", shares: "shares", recent: "createTime" }[sort] || "views";
  const sorted = [...videos].sort((a, b) => b[sortKey] - a[sortKey]);

  console.log(`\n${c.bold}${c.cyan}${accountName}${c.reset} — ${sorted.length} videos (sorted by ${sort})\n`);
  console.log(
    c.dim +
    "  #  " +
    "Views".padStart(8) + "  " +
    "Likes".padStart(7) + "  " +
    "Cmts".padStart(5) + "  " +
    "Shrs".padStart(5) + "  " +
    "Date".padEnd(10) + "  " +
    "Title" +
    c.reset
  );
  console.log(c.dim + "  " + "─".repeat(80) + c.reset);

  sorted.forEach((v, i) => {
    const date  = v.createTime ? new Date(v.createTime * 1000).toLocaleDateString() : "—";
    const title = (v.title || v.id || "").slice(0, 38);
    const num   = String(i + 1).padStart(3);
    const views = fmt(v.views).padStart(8);
    const likes = fmt(v.likes).padStart(7);
    const cmts  = fmt(v.comments).padStart(5);
    const shrs  = fmt(v.shares).padStart(5);
    const hiViews = v.views > 10000 ? c.green : v.views > 1000 ? c.yellow : c.reset;
    console.log(`  ${c.dim}${num}${c.reset}  ${hiViews}${views}${c.reset}  ${likes}  ${cmts}  ${shrs}  ${date.padEnd(10)}  ${title}`);
  });
  console.log();
}

async function cmdTop(args) {
  let n    = 10;
  let acct = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" || args[i] === "-n") n = parseInt(args[++i]) || 10;
    else if (!acct) acct = args[i];
  }
  const accountName = acct || "default";
  const data   = loadAnalytics(accountName);
  const videos = data.videos || [];
  if (!videos.length) die(`No video data for "${accountName}". Run: node analytics.js fetch`);

  const top = [...videos].sort((a, b) => b.views - a.views).slice(0, n);

  console.log(`\n${c.bold}${c.cyan}Top ${n} videos — ${accountName}${c.reset}\n`);
  top.forEach((v, i) => {
    const date   = v.createTime ? new Date(v.createTime * 1000).toLocaleDateString() : "—";
    const er     = v.views > 0 ? ((v.likes / v.views) * 100).toFixed(1) : "0.0";
    console.log(`  ${c.bold}${i + 1}.${c.reset} ${c.cyan}${fmt(v.views)}${c.reset} views  |  ${fmt(v.likes)} likes  |  ${er}% ER  |  ${date}`);
    if (v.title) console.log(`     ${c.dim}${v.title.slice(0, 80)}${c.reset}`);
    if (v.shareUrl) console.log(`     ${c.dim}${v.shareUrl}${c.reset}`);
    console.log();
  });
}

async function cmdCompare() {
  const accounts = listAccounts();
  if (accounts.length === 0) die("No accounts found. Run: node analytics.js auth");

  const rows = accounts.map(name => {
    const d = loadAnalytics(name);
    const p = d.profile || {};
    const v = d.videos  || [];
    return {
      name,
      followers:   p.followers  || 0,
      videoCount:  v.length,
      totalViews:  v.reduce((s, x) => s + x.views, 0),
      totalLikes:  v.reduce((s, x) => s + x.likes, 0),
      avgViews:    v.length ? Math.round(v.reduce((s, x) => s + x.views, 0) / v.length) : 0,
      topViews:    v.length ? Math.max(...v.map(x => x.views)) : 0,
      fetched:     d.lastFetched ? new Date(d.lastFetched).toLocaleDateString() : "never",
    };
  });

  const col = (s, w) => String(s).padStart(w);

  console.log(`\n${c.bold}Account Comparison${c.reset}\n`);
  console.log(
    c.dim +
    "  Account".padEnd(20) +
    col("Followers", 12) +
    col("Videos", 8) +
    col("Tot.Views", 12) +
    col("Avg Views", 10) +
    col("Top Video", 10) +
    "  Fetched" +
    c.reset
  );
  console.log(c.dim + "  " + "─".repeat(80) + c.reset);

  rows.forEach(r => {
    const best = rows.reduce((b, x) => x.totalViews > b.totalViews ? x : b, rows[0]);
    const hi = r.name === best.name ? c.green : c.reset;
    console.log(
      `  ${hi}${r.name.padEnd(18)}${c.reset}` +
      col(fmt(r.followers), 12) +
      col(r.videoCount, 8) +
      col(fmt(r.totalViews), 12) +
      col(fmt(r.avgViews), 10) +
      col(fmt(r.topViews), 10) +
      `  ${c.dim}${r.fetched}${c.reset}`
    );
  });
  console.log();
}

async function cmdExport(args) {
  const accountName = args[0] || "default";
  const data   = loadAnalytics(accountName);
  const videos = data.videos || [];

  if (!videos.length) die(`No data for "${accountName}". Run: node analytics.js fetch`);

  const outFile = path.join(process.cwd(), `tiktok-${accountName}-${Date.now()}.csv`);
  const header  = "id,title,date,views,likes,comments,shares,engagement_rate,share_url";
  const rows    = videos.map(v => {
    const er   = v.views > 0 ? ((v.likes / v.views) * 100).toFixed(2) : "0.00";
    const date = v.createTime ? new Date(v.createTime * 1000).toISOString().split("T")[0] : "";
    const esc  = (s) => `"${String(s || "").replace(/"/g, '""')}"`;
    return [v.id, esc(v.title), date, v.views, v.likes, v.comments, v.shares, er, esc(v.shareUrl)].join(",");
  });

  fs.writeFileSync(outFile, [header, ...rows].join("\n"));
  log.ok(`Exported ${videos.length} videos → ${outFile}`);
}

async function cmdAccounts() {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    console.log("No accounts found. Run: node analytics.js auth [name]");
    return;
  }
  console.log(`\n${c.bold}TikTok accounts:${c.reset}\n`);
  for (const name of accounts) {
    const d = loadAnalytics(name);
    const p = d.profile || {};
    const label = p.displayName ? `${p.displayName} (@${name})` : name;
    const fetched = d.lastFetched ? `last fetched ${new Date(d.lastFetched).toLocaleDateString()}` : "no data yet";
    const followers = p.followers != null ? `${fmt(p.followers)} followers` : "";
    console.log(`  ${c.cyan}${name.padEnd(16)}${c.reset}${label.padEnd(24)}  ${c.dim}${followers}  ${fetched}${c.reset}`);
  }
  console.log();
  console.log(`${c.dim}Tip: node analytics.js fetch --all    to refresh all accounts${c.reset}`);
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function showHelp() {
  console.log(`
${c.bold}${c.cyan}analytics${c.reset} — TikTok analytics CLI

Each account's data is saved separately in:
  ${c.dim}~/.larry-cli/accounts/<account>/analytics.json${c.reset}

${c.bold}Setup (first time):${c.reset}
  node analytics.js auth              Authorize default account with analytics scopes
  node analytics.js auth mybrand2     Authorize a second account

${c.bold}Commands:${c.reset}
  ${c.cyan}auth${c.reset} [account]               Authorize with full analytics scopes (opens browser)
  ${c.cyan}fetch${c.reset} [account | --all]       Pull latest data from TikTok API
  ${c.cyan}accounts${c.reset}                      List all authorized accounts
  ${c.cyan}stats${c.reset} [account]               Profile overview — followers, totals, growth
  ${c.cyan}videos${c.reset} [account] [--sort]     Full video table  (--sort views|likes|comments|recent)
  ${c.cyan}top${c.reset} [account] [--n 10]        Top N videos by views
  ${c.cyan}compare${c.reset}                       Side-by-side comparison of all accounts
  ${c.cyan}export${c.reset} [account]              Export videos to CSV file

${c.bold}Examples:${c.reset}
  node analytics.js auth
  node analytics.js auth brand2
  node analytics.js fetch --all
  node analytics.js stats
  node analytics.js stats brand2
  node analytics.js videos --sort likes
  node analytics.js top --n 20
  node analytics.js compare
  node analytics.js export brand2
`);
}

// ─── Number formatter ─────────────────────────────────────────────────────────
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") { showHelp(); return; }

  const commands = {
    auth:     () => cmdAuth(args),
    fetch:    () => cmdFetch(args),
    accounts: () => cmdAccounts(),
    stats:    () => cmdStats(args),
    videos:   () => cmdVideos(args),
    top:      () => cmdTop(args),
    compare:  () => cmdCompare(),
    export:   () => cmdExport(args),
  };

  const fn = commands[command];
  if (!fn) { log.err(`Unknown command: ${command}`); showHelp(); process.exit(1); }

  try { await fn(); } catch (e) { die(e.message); }
}

main();
