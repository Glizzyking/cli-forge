#!/usr/bin/env node

/**
 * larry — AI-powered TikTok-to-Carousel content engine
 *
 * Commands:
 *   larry init                          Set up API keys
 *   larry auth                          TikTok OAuth2 (opens browser)
 *   larry add <tiktok-url>              Download + analyze TikTok into database
 *   larry list                          Show all TikToks in database
 *   larry create [options]              Generate carousel + post as TikTok draft
 *   larry schedule [--time HH:MM]       Start daily scheduler (default: 16:00)
 *   larry test [url]                    Run full pipeline test
 *   larry penpot [post-id]              Push carousel to Penpot, get shareable link
 *
 * Requires:
 *   GEMINI_API_KEY           Google Gemini API key
 *   TIKTOK_CLIENT_KEY        TikTok developer app client key
 *   TIKTOK_CLIENT_SECRET     TikTok developer app client secret
 *   IMGUR_CLIENT_ID          Imgur API client ID (free at api.imgur.com)
 *   yt-dlp                   Must be on PATH: pip install yt-dlp
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const http = require("http");
const { execSync, spawnSync } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

const CONFIG_DIR  = path.join(os.homedir(), ".larry-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DB_FILE     = path.join(CONFIG_DIR, "db.json");
const TMP_DIR     = path.join(CONFIG_DIR, "tmp");

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset:   "\x1b[0m", bold:    "\x1b[1m", dim: "\x1b[2m",
  cyan:    "\x1b[36m", green:  "\x1b[32m", yellow: "\x1b[33m",
  red:     "\x1b[31m", blue:   "\x1b[34m", magenta: "\x1b[35m",
};

const log = {
  info:  (m) => process.stderr.write(`${c.cyan}[larry]${c.reset} ${m}\n`),
  ok:    (m) => process.stderr.write(`${c.green}[✓]${c.reset} ${m}\n`),
  warn:  (m) => process.stderr.write(`${c.yellow}[!]${c.reset} ${m}\n`),
  err:   (m) => process.stderr.write(`${c.red}[✗]${c.reset} ${m}\n`),
  step:  (m) => process.stderr.write(`${c.blue}[→]${c.reset} ${m}\n`),
  ai:    (m) => process.stderr.write(`${c.magenta}[ai]${c.reset} ${m}\n`),
};

function die(msg) { log.err(msg); process.exit(1); }

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getConfig() {
  const cfg = loadConfig();
  return {
    geminiKey:          cfg.geminiKey          || process.env.GEMINI_API_KEY          || "",
    tiktokClientKey:    cfg.tiktokClientKey    || process.env.TIKTOK_CLIENT_KEY       || "",
    tiktokClientSecret: cfg.tiktokClientSecret || process.env.TIKTOK_CLIENT_SECRET    || "",
    imgurClientId:      cfg.imgurClientId      || process.env.IMGUR_CLIENT_ID         || "",
    scheduleTime:       cfg.scheduleTime       || "16:00",
    tokens:             cfg.tokens             || {},   // { accountName: { access_token, refresh_token, open_id, expires_at } }
  };
}

// ─── Database ─────────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { tiktoks: [], posts: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return { tiktoks: [], posts: [] }; }
}

function saveDB(db) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Gemini API ───────────────────────────────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

async function geminiGenerate(apiKey, model, userPrompt, systemPrompt = null) {
  const body = { contents: [{ role: "user", parts: [{ text: userPrompt }] }] };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${model} error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
  return parts.map(p => p.text || "").join("");
}

async function geminiGenerateWithFile(apiKey, model, filePath, mimeType, userPrompt) {
  log.ai("Uploading file to Gemini File API...");

  const fileBytes = fs.readFileSync(filePath);

  // Step 1: Upload file
  const uploadRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command":            "start, upload, finalize",
        "X-Goog-Upload-Header-Content-Length": String(fileBytes.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type":                      mimeType,
      },
      body: fileBytes,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Gemini file upload error ${uploadRes.status}: ${err}`);
  }

  const fileInfo = await uploadRes.json();
  const fileUri  = fileInfo?.file?.uri;
  const fileName = fileInfo?.file?.name;

  if (!fileUri) throw new Error(`No file URI in Gemini upload response: ${JSON.stringify(fileInfo)}`);

  // Step 2: Wait for processing
  let state = fileInfo?.file?.state || "PROCESSING";
  let attempts = 0;
  while (state === "PROCESSING" && attempts < 30) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes  = await fetch(`${GEMINI_BASE}/${fileName}?key=${apiKey}`);
    const statusData = await statusRes.json();
    state = statusData?.state || "ACTIVE";
    attempts++;
  }

  if (state !== "ACTIVE") throw new Error(`File processing failed (state: ${state})`);

  // Step 3: Generate
  const body = {
    contents: [{
      role: "user",
      parts: [{ fileData: { mimeType, fileUri } }, { text: userPrompt }],
    }],
  };

  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini generate error ${res.status}: ${err}`);
  }

  const data  = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error(`Gemini returned no content: ${JSON.stringify(data)}`);
  return parts.map(p => p.text || "").join("");
}

async function geminiEmbed(apiKey, text) {
  // Try text-embedding-004 (v1)
  for (const base of [
    "https://generativelanguage.googleapis.com/v1",
    "https://generativelanguage.googleapis.com/v1beta",
  ]) {
    try {
      const res = await fetch(
        `${base}/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "models/text-embedding-004", content: { parts: [{ text }] } }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const vec = data?.embedding?.values;
        if (vec && vec.length > 0) return vec;
      }
    } catch {}
  }

  // Fallback: TF-IDF sparse vector for similarity (no API needed)
  log.warn("Embedding API unavailable — using TF-IDF sparse vectors for RAG.");
  return tfidfVector(text);
}

// ─── TF-IDF fallback embedding ────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function tfidfVector(text, dimensions = 512) {
  const tokens = tokenize(text);
  const vec    = new Array(dimensions).fill(0);
  const freq   = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  for (const [term, count] of Object.entries(freq)) {
    // Hash term to dimension slot
    let hash = 0;
    for (let i = 0; i < term.length; i++) hash = (hash * 31 + term.charCodeAt(i)) >>> 0;
    const slot = hash % dimensions;
    vec[slot] += count / tokens.length;
  }
  // L2 normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

async function geminiGenerateImage(apiKey, prompt) {
  // Gemini Imagen 3
  const res = await fetch(
    `${GEMINI_BASE}/models/imagen-3.0-generate-001:predict?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: "9:16", outputMimeType: "image/png" },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini Imagen error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const b64  = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error(`No image in Gemini Imagen response: ${JSON.stringify(data)}`);
  return Buffer.from(b64, "base64");
}

// ─── Vector similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function findSimilar(queryEmbedding, tiktoks, topK = 3) {
  return tiktoks
    .filter(t => t.embedding && t.embedding.length > 0)
    .map(t => ({ ...t, score: cosineSimilarity(queryEmbedding, t.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ─── TikTok download ──────────────────────────────────────────────────────────

function findYtDlp() {
  // Try direct command first
  try { execSync("yt-dlp --version", { stdio: "pipe" }); return ["yt-dlp"]; }
  catch {}
  // Try via python -m yt_dlp
  try { execSync("python -m yt_dlp --version", { stdio: "pipe" }); return ["python", "-m", "yt_dlp"]; }
  catch {}
  // Try python3
  try { execSync("python3 -m yt_dlp --version", { stdio: "pipe" }); return ["python3", "-m", "yt_dlp"]; }
  catch {}
  return null;
}

function downloadTikTok(url, outDir) {
  const ytdlp = findYtDlp();
  if (!ytdlp) die("yt-dlp not found. Install with: pip install yt-dlp");
  fs.mkdirSync(outDir, { recursive: true });

  const [bin, ...prefix] = ytdlp;
  const outTemplate = path.join(outDir, "%(id)s.%(ext)s");

  // Try video first
  log.step("Downloading TikTok (video)...");
  const videoResult = spawnSync(bin, [
    ...prefix, "--no-playlist", "-f", "mp4/best",
    "-o", outTemplate, "--print", "filename", url,
  ], { encoding: "utf8", timeout: 120000 });

  if (videoResult.status === 0) {
    const filename = (videoResult.stdout || "").trim().split("\n").pop();
    if (filename && fs.existsSync(filename)) return filename;
    const vids = fs.readdirSync(outDir).filter(f => /\.(mp4|webm|mkv|mov)$/i.test(f));
    if (vids.length > 0) return path.join(outDir, vids[0]);
  }

  // Fallback: photo slideshow — download all images
  log.step("Video download failed, trying photo/slideshow download...");
  const photoResult = spawnSync(bin, [
    ...prefix, "--no-playlist", "--write-pages",
    "-o", outTemplate, "--skip-download",
    "--write-info-json", url,
  ], { encoding: "utf8", timeout: 120000 });

  // Also try downloading images directly
  spawnSync(bin, [
    ...prefix, "--no-playlist",
    "-o", outTemplate, url,
  ], { encoding: "utf8", timeout: 120000 });

  // Return first media file found (image or video)
  const allFiles = fs.readdirSync(outDir).filter(f =>
    /\.(mp4|webm|mkv|mov|jpg|jpeg|png|webp)$/i.test(f) && !f.endsWith(".info.json")
  );
  if (allFiles.length > 0) return path.join(outDir, allFiles[0]);

  throw new Error("No downloadable media found — yt-dlp could not extract this URL");
}

// ─── Imgur upload ─────────────────────────────────────────────────────────────

async function uploadToImgur(clientId, imageBuffer) {
  const b64 = imageBuffer.toString("base64");
  const res = await fetch("https://api.imgur.com/3/image", {
    method: "POST",
    headers: {
      "Authorization": `Client-ID ${clientId}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ image: b64, type: "base64" }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Imgur upload error ${res.status}: ${err}`);
  }

  const data = await res.json();
  if (!data?.data?.link) throw new Error(`No link in Imgur response: ${JSON.stringify(data)}`);
  return data.data.link; // public HTTPS URL
}

// ─── TikTok OAuth ─────────────────────────────────────────────────────────────

const TIKTOK_BASE     = "https://open.tiktokapis.com";
const OAUTH_CALLBACK  = "http://localhost:8347/callback";
const OAUTH_PORT      = 8347;

async function tiktokOAuthFlow(clientKey, clientSecret) {
  const state   = Math.random().toString(36).slice(2);
  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=video.publish,video.upload&response_type=code&redirect_uri=${encodeURIComponent(OAUTH_CALLBACK)}&state=${state}`;

  console.log(`\n${c.bold}Open this URL in your browser:${c.reset}\n${c.cyan}${authUrl}${c.reset}\n`);

  // Try to auto-open
  const opener = process.platform === "win32" ? "start" :
                 process.platform === "darwin" ? "open" : "xdg-open";
  try { execSync(`${opener} "${authUrl}"`, { stdio: "ignore" }); } catch {}

  // Start local server to capture callback
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url, `http://localhost:${OAUTH_PORT}`);
      const code   = urlObj.searchParams.get("code");
      const gotState = urlObj.searchParams.get("state");

      if (!code) {
        res.writeHead(400); res.end("Missing code"); return;
      }
      if (gotState !== state) {
        res.writeHead(400); res.end("State mismatch"); return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>✓ Authorized! You can close this tab.</h2></body></html>");
      server.close();

      // Exchange code for tokens
      try {
        const tokenRes = await fetch(`${TIKTOK_BASE}/v2/oauth/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key:    clientKey,
            client_secret: clientSecret,
            code,
            grant_type:    "authorization_code",
            redirect_uri:  OAUTH_CALLBACK,
          }).toString(),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          return reject(new Error(`Token exchange failed: ${err}`));
        }

        const tokens = await tokenRes.json();
        resolve(tokens);
      } catch (e) {
        reject(e);
      }
    });

    server.listen(OAUTH_PORT, () => log.info(`Waiting for OAuth callback on port ${OAUTH_PORT}...`));
    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(() => { server.close(); reject(new Error("OAuth timeout (5 min)")); }, 300000);
  });
}

async function refreshTiktokToken(clientKey, clientSecret, refreshToken) {
  const res = await fetch(`${TIKTOK_BASE}/v2/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key:    clientKey,
      client_secret: clientSecret,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  return res.json();
}

async function getValidToken(config, accountName = "default") {
  const tokenData = config.tokens[accountName];
  if (!tokenData) throw new Error(`No token for account "${accountName}". Run: larry auth`);

  // Refresh if expired (with 5-min buffer)
  if (Date.now() > (tokenData.expires_at - 300000)) {
    log.step("Refreshing TikTok access token...");
    const newTokens = await refreshTiktokToken(
      config.tiktokClientKey, config.tiktokClientSecret, tokenData.refresh_token
    );
    tokenData.access_token   = newTokens.access_token;
    tokenData.refresh_token  = newTokens.refresh_token || tokenData.refresh_token;
    tokenData.expires_at     = Date.now() + (newTokens.expires_in * 1000);
    config.tokens[accountName] = tokenData;
    saveConfig({ ...loadConfig(), tokens: config.tokens });
    log.ok("Token refreshed");
  }

  return tokenData.access_token;
}

// ─── TikTok posting ───────────────────────────────────────────────────────────

async function postCarouselToTikTok(accessToken, { title, imageUrls }) {
  // Post as MEDIA_UPLOAD (inbox/draft mode — sends to user for review)
  const body = {
    post_info: {
      title:           title.slice(0, 90),
      privacy_level:   "SELF_ONLY",   // private until user publishes
      disable_comment: false,
      auto_add_music:  true,
    },
    source_info: {
      source:            "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images:      imageUrls,
    },
    post_mode:   "MEDIA_UPLOAD",   // sends to inbox as draft
    media_type:  "PHOTO",
  };

  const res = await fetch(`${TIKTOK_BASE}/v2/post/publish/content/init/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type":  "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok post error ${res.status}: ${err}`);
  }

  return res.json();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdInit() {
  const rl  = require("readline").createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));

  console.log(`\n${c.bold}${c.cyan}larry init${c.reset} — Configure API keys\n`);

  const cfg = loadConfig();

  const masked = (v) => v ? `****${v.slice(-4)}` : "not set";

  cfg.geminiKey          = (await ask(`Gemini API key [${masked(cfg.geminiKey)}]: `))          || cfg.geminiKey || "";
  cfg.tiktokClientKey    = (await ask(`TikTok client key [${masked(cfg.tiktokClientKey)}]: `))    || cfg.tiktokClientKey || "";
  cfg.tiktokClientSecret = (await ask(`TikTok client secret [${masked(cfg.tiktokClientSecret)}]: `)) || cfg.tiktokClientSecret || "";
  cfg.imgurClientId      = (await ask(`Imgur client ID [${masked(cfg.imgurClientId)}]: `))      || cfg.imgurClientId || "";
  cfg.scheduleTime       = (await ask(`Daily post time [${cfg.scheduleTime || "16:00"}]: `))    || cfg.scheduleTime || "16:00";

  console.log(`\n${c.dim}── Penpot (optional — for editable post mockups) ──${c.reset}`);
  cfg.penpotUrl      = (await ask(`Penpot URL [${cfg.penpotUrl || "https://design.penpot.app"}]: `)) || cfg.penpotUrl || "https://design.penpot.app";
  cfg.penpotEmail    = (await ask(`Penpot email [${cfg.penpotEmail || "not set"}]: `))    || cfg.penpotEmail || "";
  cfg.penpotPassword = (await ask(`Penpot password [${cfg.penpotPassword ? "****" : "not set"}]: `)) || cfg.penpotPassword || "";

  rl.close();
  saveConfig(cfg);
  log.ok(`Config saved to ${CONFIG_FILE}`);
  console.log(`\nNext: run ${c.cyan}larry auth${c.reset} to authorize your TikTok account.`);
}

async function cmdAuth(args) {
  const config      = getConfig();
  const accountName = args[0] || "default";

  if (!config.tiktokClientKey)    die("tiktokClientKey not set. Run: larry init");
  if (!config.tiktokClientSecret) die("tiktokClientSecret not set. Run: larry init");

  log.info(`Starting TikTok OAuth for account: ${accountName}`);

  const tokens    = await tiktokOAuthFlow(config.tiktokClientKey, config.tiktokClientSecret);
  const cfg       = loadConfig();
  cfg.tokens      = cfg.tokens || {};
  cfg.tokens[accountName] = {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    open_id:       tokens.open_id,
    expires_at:    Date.now() + (tokens.expires_in * 1000),
  };

  saveConfig(cfg);
  log.ok(`TikTok account "${accountName}" authorized!`);
  log.info(`open_id: ${tokens.open_id}`);
}

async function cmdAdd(args) {
  const url = args[0];
  if (!url) die("Usage: larry add <tiktok-url>");

  const config = getConfig();
  if (!config.geminiKey) die("geminiKey not set. Run: larry init");

  const db = loadDB();
  if (db.tiktoks.find(t => t.url === url)) {
    log.warn(`Already in database: ${url}`);
    return;
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  let analysis = "";

  // Try to download video
  let videoPath = null;
  try {
    videoPath = downloadTikTok(url, TMP_DIR);
    log.ok(`Downloaded: ${path.basename(videoPath)}`);

    // Analyze with Gemini 2 Flash (multimodal)
    log.ai("Analyzing video with Gemini 2 Flash...");
    const mimeType = videoPath.endsWith(".mp4") ? "video/mp4" : "video/webm";
    analysis = await geminiGenerateWithFile(
      config.geminiKey, "gemini-2.0-flash", videoPath, mimeType,
      `Analyze this TikTok video fully and return ONLY a JSON object (no markdown) with these fields:
{
  "hook": "first 3 seconds hook / opening line",
  "topic": "main topic or message",
  "transcript": "full spoken + on-screen text transcript",
  "visualStyle": "colors, aesthetic, image types, fonts",
  "cta": "call to action",
  "tone": "emotional tone",
  "audience": "target audience",
  "slideSuggestions": ["suggestion for slide 1", "slide 2", "..."],
  "performanceFactors": ["why this content performs well"]
}`
    );
  } catch (e) {
    log.warn(`Video analysis failed: ${e.message}. Using text-only analysis.`);
    log.ai("Analyzing TikTok URL with Gemini (fallback)...");
    analysis = await geminiGenerate(
      config.geminiKey, "gemini-2.0-flash",
      `Analyze this TikTok URL and create a content analysis JSON (no markdown):
URL: ${url}
Return: { hook, topic, transcript, visualStyle, cta, tone, audience, slideSuggestions, performanceFactors }`
    );
  }

  // Clean up video
  if (videoPath && fs.existsSync(videoPath)) {
    try { fs.unlinkSync(videoPath); } catch {}
  }

  // Generate embedding
  log.ai("Generating content embedding with text-embedding-004...");
  const textToEmbed = `${url}\n${analysis}`;
  const embedding   = await geminiEmbed(config.geminiKey, textToEmbed);

  const entry = {
    id:        Date.now().toString(),
    url,
    analysis,
    embedding,
    createdAt: new Date().toISOString(),
  };

  db.tiktoks.push(entry);
  saveDB(db);

  log.ok(`Added TikTok #${entry.id} to database`);

  // Preview
  let preview = analysis;
  try {
    const parsed = JSON.parse(analysis.replace(/```json\n?|```/g, "").trim());
    preview = `hook: "${parsed.hook}"\ntopic: "${parsed.topic}"\naudience: "${parsed.audience}"`;
  } catch {}
  console.log(`\n${c.dim}Preview:${c.reset}\n${preview.slice(0, 300)}`);
}

async function cmdList() {
  const db = loadDB();
  if (db.tiktoks.length === 0) {
    console.log("No TikToks in database. Add one with: larry add <url>");
    return;
  }

  console.log(`\n${c.bold}TikToks in database (${db.tiktoks.length}):${c.reset}\n`);
  for (const t of db.tiktoks) {
    let topic = "unknown";
    try { topic = JSON.parse(t.analysis.replace(/```json\n?|```/g, "").trim()).topic || "unknown"; } catch {}
    console.log(`  ${c.cyan}#${t.id}${c.reset}  ${t.url}`);
    console.log(`  ${c.dim}topic: ${topic} | added: ${new Date(t.createdAt).toLocaleDateString()} | embedding: ${t.embedding?.length > 0 ? "✓" : "✗"}${c.reset}\n`);
  }

  console.log(`\n${c.bold}Posts created (${(db.posts || []).length}):${c.reset}`);
  for (const p of (db.posts || [])) {
    console.log(`  ${c.cyan}#${p.id}${c.reset}  ${p.status} — ${p.account || "default"} — ${new Date(p.createdAt).toLocaleDateString()}`);
  }
}

async function cmdCreate(args) {
  const config = getConfig();
  if (!config.geminiKey)     die("geminiKey not set. Run: larry init");
  if (!config.imgurClientId) die("imgurClientId not set. Run: larry init");

  let account = "default";
  let topic   = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--account" || args[i] === "-a") account = args[++i];
    if (args[i] === "--topic"   || args[i] === "-t") topic   = args[++i];
  }

  const db = loadDB();
  if (db.tiktoks.length === 0) die("No TikToks in database. Run: larry add <url> first.");

  // ── Step 1: RAG — find relevant content ──
  log.step("Querying embeddings for relevant content...");
  const queryText      = topic || "high-performing viral TikTok marketing carousel";
  const queryEmbedding = await geminiEmbed(config.geminiKey, queryText);
  const similar        = findSimilar(queryEmbedding, db.tiktoks, 3);

  const context = similar.map((t, i) => {
    let analysisText = t.analysis;
    try {
      const parsed = JSON.parse(t.analysis.replace(/```json\n?|```/g, "").trim());
      analysisText = JSON.stringify(parsed, null, 2);
    } catch {}
    return `=== Reference ${i + 1} (similarity: ${t.score.toFixed(3)}) ===\n${t.url}\n${analysisText}`;
  }).join("\n\n");

  // ── Step 2: Generate carousel slide copy ──
  log.ai("Generating carousel slides with Gemini 2 Flash...");

  const slidesRaw = await geminiGenerate(
    config.geminiKey, "gemini-2.0-flash",
    `Based on these high-performing TikTok content references, create a NEW viral carousel post.

REFERENCES:
${context}

${topic ? `TOPIC: ${topic}` : "Pick the strongest topic from the references."}

Rules:
- 6-8 slides total
- Slide 1: reaction-style hook ("Wait this is actually nice??", "I can't believe this works")
- Slides 2-5: build curiosity, deliver value, one idea per slide
- Slide 6+: strong CTA
- 5-15 words max per slide text
- Visual style: dark/moody background, bold white text, minimal design, portrait 9:16

Output ONLY a valid JSON array, no markdown fences:
[
  { "slide": 1, "text": "...", "imagePrompt": "ultra-minimal dark background portrait 9:16 image with bold white text overlay: '...', cinematic lighting, professional product aesthetic" },
  ...
]`,
    "You are a viral TikTok content strategist who has driven 1M+ views on carousel posts."
  );

  let slides;
  try {
    const cleaned = slidesRaw.replace(/```json\n?|```/g, "").trim();
    slides = JSON.parse(cleaned);
  } catch (e) {
    die(`Failed to parse slides JSON: ${e.message}\n\nRaw output:\n${slidesRaw.slice(0, 500)}`);
  }

  console.log(`\n${c.bold}Generated ${slides.length} slides:${c.reset}`);
  slides.forEach(s => console.log(`  ${c.cyan}${s.slide}.${c.reset} "${s.text}"`));

  // ── Step 3: Generate images with Gemini Imagen 3 ──
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const imageUrls = [];

  for (const slide of slides) {
    log.ai(`Generating image for slide ${slide.slide}/${slides.length}...`);
    try {
      const imgBuffer = await geminiGenerateImage(config.geminiKey, slide.imagePrompt);
      const tmpPath   = path.join(TMP_DIR, `slide_${slide.slide}_${Date.now()}.png`);
      fs.writeFileSync(tmpPath, imgBuffer);

      // Upload to Imgur
      log.step(`Uploading slide ${slide.slide} to Imgur...`);
      const imgurUrl = await uploadToImgur(config.imgurClientId, imgBuffer);
      imageUrls.push(imgurUrl);

      // Clean up local file
      try { fs.unlinkSync(tmpPath); } catch {}
      log.ok(`Slide ${slide.slide}: ${imgurUrl}`);
    } catch (e) {
      log.warn(`Slide ${slide.slide} image failed: ${e.message}. Skipping.`);
    }
  }

  if (imageUrls.length === 0) die("No images generated. Check Gemini Imagen and Imgur setup.");
  if (imageUrls.length < 2)   die("TikTok carousels require at least 2 images.");

  // ── Step 4: Post to TikTok as draft ──
  const accessToken = await getValidToken(config, account);
  const title       = slides[0]?.text || "Check this out 🔥";

  log.step(`Posting ${imageUrls.length}-slide carousel to TikTok (draft/inbox)...`);
  const result = await postCarouselToTikTok(accessToken, { title, imageUrls });

  log.ok(`Carousel sent to TikTok inbox! publish_id: ${result?.data?.publish_id || "unknown"}`);
  log.info("Open TikTok → Inbox to review and publish your carousel.");
  if (config.penpotEmail) {
    log.info(`Tip: run ${c.cyan}larry penpot${c.reset} to create an editable Penpot mockup with a shareable link.`);
  }

  // Save to DB
  db.posts = db.posts || [];
  db.posts.push({
    id:         Date.now().toString(),
    slides:     slides.map((s, i) => ({ ...s, imageUrl: imageUrls[i] || null })),
    imageUrls,
    account,
    status:     "draft",
    publishId:  result?.data?.publish_id,
    createdAt:  new Date().toISOString(),
  });
  saveDB(db);
}

async function cmdPenpot(args) {
  const config = getConfig();
  if (!config.penpotEmail || !config.penpotPassword) {
    die("Penpot credentials not set. Run: larry init\n\nSign up free at https://penpot.app — then run larry init to add your email + password.");
  }

  const db = loadDB();
  const posts = db.posts || [];
  if (posts.length === 0) die("No posts yet. Run: larry create");

  // Pick post by ID arg or latest
  let post;
  if (args[0]) {
    post = posts.find(p => p.id === args[0]);
    if (!post) die(`Post ID "${args[0]}" not found. Run: larry list`);
  } else {
    post = posts[posts.length - 1];
  }

  if (!post.slides || post.slides.length === 0) die("Post has no slide data.");
  if (!post.imageUrls || post.imageUrls.length === 0) die("Post has no images uploaded yet.");

  log.info(`Creating Penpot mockup for post #${post.id} (${post.slides.length} slides)...`);
  log.info(`Connecting to ${config.penpotUrl || "https://design.penpot.app"}...`);

  const { buildMockup } = require("./penpot-api");

  try {
    log.step("Logging in to Penpot...");
    const result = await buildMockup(config, post);

    log.ok(`Penpot mockup created!`);
    console.log(`\n${c.bold}${c.cyan}Edit your post mockup:${c.reset}`);
    console.log(`  ${c.green}${result.url}${c.reset}\n`);
    console.log(`${c.dim}Open the link — edit any text or images — share with your team.${c.reset}`);

    // Save link to DB
    post.penpotUrl = result.url;
    post.penpotFileId = result.fileId;
    saveDB(db);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      die(`Penpot login failed. Check your email/password in: larry init`);
    }
    throw e;
  }
}

async function cmdSchedule(args) {
  const config = getConfig();
  let time = config.scheduleTime || "16:00";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--time" || args[i] === "-t") time = args[++i];
    if (args[i] === "--account" || args[i] === "-a") {
      // pass through to create
    }
  }

  const [hours, minutes] = time.split(":").map(Number);
  if (isNaN(hours) || isNaN(minutes)) die(`Invalid time format: ${time}. Use HH:MM`);

  log.ok(`Scheduler running. Will post carousel drafts daily at ${time}`);
  log.info("Press Ctrl+C to stop.\n");

  let lastFired = null;

  const tick = () => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${hours}-${minutes}`;
    if (now.getHours() === hours && now.getMinutes() === minutes && lastFired !== key) {
      lastFired = key;
      log.info(`Firing at ${now.toLocaleTimeString()}...`);
      cmdCreate(args.filter(a => a !== "--time" && a !== time)).catch(e =>
        log.err(`Scheduled post failed: ${e.message}`)
      );
    }
  };

  setInterval(tick, 30000); // check every 30 seconds
  tick();
}

async function cmdTest(args) {
  const url = args[0] || "https://www.tiktok.com/t/ZTk1PdKcv/";
  console.log(`\n${c.bold}${c.cyan}larry test${c.reset} — Full pipeline test\n`);
  log.info(`Test TikTok: ${url}`);

  // Step 1: add
  log.step("(1/2) Adding TikTok to database...");
  await cmdAdd([url]);

  // Step 2: list
  log.step("(2/2) Database state:");
  await cmdList();

  console.log(`\n${c.green}Test complete!${c.reset}`);
  console.log(`Next:\n  1. ${c.cyan}larry auth${c.reset}         — authorize TikTok account`);
  console.log(`  2. ${c.cyan}larry create${c.reset}       — generate + post carousel draft`);
  console.log(`  3. ${c.cyan}larry schedule${c.reset}     — run daily at 4 PM`);
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
${c.bold}${c.cyan}larry${c.reset} — AI-powered TikTok-to-Carousel content engine

  Analyzes TikToks with Gemini 2 Flash, builds a RAG database using
  Gemini text-embedding-004, generates carousel slides + images with
  Gemini Imagen 3, hosts on Imgur, and posts to TikTok as drafts.

${c.bold}Setup:${c.reset}
  1. ${c.cyan}larry init${c.reset}            — configure API keys
  2. ${c.cyan}larry auth${c.reset}            — authorize TikTok (opens browser)
  3. ${c.cyan}larry add <url>${c.reset}       — add TikToks to the database
  4. ${c.cyan}larry create${c.reset}          — generate + post carousel draft
  5. ${c.cyan}larry schedule${c.reset}        — run daily at 4 PM

${c.bold}Commands:${c.reset}
  ${c.cyan}init${c.reset}                       Configure all API keys interactively
  ${c.cyan}auth${c.reset} [account-name]        TikTok OAuth2 (default: "default")
  ${c.cyan}add${c.reset} <tiktok-url>           Download, analyze, embed → save to database
  ${c.cyan}list${c.reset}                       Show all TikToks + posts in database
  ${c.cyan}create${c.reset} [options]           Generate carousel → post as TikTok draft
    ${c.dim}--account, -a <name>${c.reset}      TikTok account to post from (default: "default")
    ${c.dim}--topic, -t <text>${c.reset}        Optional topic hint for content generation
  ${c.cyan}schedule${c.reset} [options]         Start daily scheduler
    ${c.dim}--time HH:MM${c.reset}              Post time (default: 16:00)
    ${c.dim}--account, -a <name>${c.reset}      Account to post from
  ${c.cyan}test${c.reset} [tiktok-url]          Full pipeline test (no TikTok posting)
  ${c.cyan}penpot${c.reset} [post-id]           Push carousel to Penpot → get shareable edit link
    ${c.dim}(no post-id = uses latest post)${c.reset}

${c.bold}Required API keys:${c.reset}
  GEMINI_API_KEY          google.ai/studio → Create API key
  TIKTOK_CLIENT_KEY       developers.tiktok.com → Create app
  TIKTOK_CLIENT_SECRET    developers.tiktok.com → Create app
  IMGUR_CLIENT_ID         api.imgur.com/oauth2/addclient (free)

  All can be set via ${c.cyan}larry init${c.reset} or as environment variables.

${c.bold}TikTok app setup:${c.reset}
  1. Go to developers.tiktok.com → Create app
  2. Add product: "Content Posting API"
  3. Set redirect URI: http://localhost:8347/callback
  4. Note your client_key and client_secret

${c.bold}Examples:${c.reset}
  node larry.js init
  node larry.js auth
  node larry.js add https://www.tiktok.com/t/ZTk1PdKcv/
  node larry.js add https://www.tiktok.com/@user/video/123
  node larry.js create --topic "productivity hacks"
  node larry.js schedule --time 16:00
  node larry.js test
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === "--help" || command === "-h") { showHelp(); return; }

  const commands = {
    init:     () => cmdInit(),
    auth:     () => cmdAuth(args),
    add:      () => cmdAdd(args),
    list:     () => cmdList(),
    create:   () => cmdCreate(args),
    schedule: () => cmdSchedule(args),
    test:     () => cmdTest(args),
    penpot:   () => cmdPenpot(args),
  };

  const fn = commands[command];
  if (!fn) { log.err(`Unknown command: ${command}`); showHelp(); process.exit(1); }

  try { await fn(); } catch (e) { die(e.message); }
}

main();
