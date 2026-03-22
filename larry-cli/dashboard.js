#!/usr/bin/env node
"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { spawn } = require("child_process");

// ─── Paths ────────────────────────────────────────────────────────────────────

const CONFIG_DIR  = path.join(os.homedir(), ".larry-cli");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const DB_FILE     = path.join(CONFIG_DIR, "db.json");
const LARRY_JS    = path.join(__dirname, "larry.js");
const PORT        = 3001;

// ─── In-memory log store ──────────────────────────────────────────────────────

const logLines = [];
const logListeners = new Set();

function pushLog(line) {
  const entry = { t: Date.now(), line };
  logLines.push(entry);
  if (logLines.length > 2000) logLines.shift();
  for (const fn of logListeners) {
    try { fn(entry); } catch {}
  }
}

// ─── Scheduler state ─────────────────────────────────────────────────────────

let schedulerProc = null;
let schedulerOn   = false;

function startScheduler(time) {
  if (schedulerProc) return;
  const cfg = loadConfig();
  const env  = buildEnv(cfg);
  const args = ["larry.js", "schedule", "--time", time || cfg.scheduleTime || "16:00"];
  schedulerProc = spawn("node", args, { cwd: __dirname, env, stdio: ["ignore","pipe","pipe"] });
  schedulerOn = true;
  schedulerProc.stdout.on("data", d => pushLog(d.toString()));
  schedulerProc.stderr.on("data", d => pushLog(d.toString()));
  schedulerProc.on("exit", () => { schedulerProc = null; schedulerOn = false; });
  pushLog(`[larry] Scheduler started (${time || cfg.scheduleTime || "16:00"})\n`);
}

function stopScheduler() {
  if (schedulerProc) {
    schedulerProc.kill();
    schedulerProc = null;
  }
  schedulerOn = false;
  pushLog("[larry] Scheduler stopped\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { tiktoks: [], posts: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return { tiktoks: [], posts: [] }; }
}

function saveDB(db) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function maskKey(v) {
  if (!v || v.length < 4) return v ? "****" : "";
  return "****" + v.slice(-4);
}

function buildEnv(cfg) {
  return {
    ...process.env,
    GEMINI_API_KEY:       cfg.geminiKey          || "",
    TIKTOK_CLIENT_KEY:    cfg.tiktokClientKey    || "",
    TIKTOK_CLIENT_SECRET: cfg.tiktokClientSecret || "",
    IMGUR_CLIENT_ID:      cfg.imgurClientId      || "",
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type":                "text/event-stream",
    "Cache-Control":               "no-cache",
    "Connection":                  "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
}

function sseWrite(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
}

function spawnStream(res, args, env) {
  sseHeaders(res);
  const proc = spawn("node", [LARRY_JS, ...args], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  function onData(chunk) {
    const line = chunk.toString();
    pushLog(line);
    sseWrite(res, { line });
  }

  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("error", err => {
    sseWrite(res, { line: `[✗] spawn error: ${err.message}\n`, error: true });
    sseWrite(res, { done: true, exitCode: -1 });
    res.end();
  });
  proc.on("exit", code => {
    sseWrite(res, { done: true, exitCode: code });
    res.end();
  });
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>larry dashboard</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #0a0a0f;
  --card:      #111118;
  --sidebar:   #1a1a24;
  --border:    rgba(255,255,255,0.08);
  --primary:   #7c3aed;
  --primary-h: #6d28d9;
  --success:   #10b981;
  --error:     #ef4444;
  --warning:   #f59e0b;
  --cyan:      #06b6d4;
  --muted:     rgba(255,255,255,0.4);
  --text:      rgba(255,255,255,0.9);
  --radius:    12px;
  --sidebar-w: 220px;
}

html, body { height: 100%; background: var(--bg); color: var(--text); font-family: system-ui,-apple-system,sans-serif; font-size: 14px; }

/* ── Layout ── */
#app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

/* ── Topbar ── */
#topbar {
  display: flex; align-items: center; gap: 16px;
  padding: 0 24px; height: 56px;
  background: var(--card); border-bottom: 1px solid var(--border);
  flex-shrink: 0; z-index: 10;
}
#logo { font-size: 20px; font-weight: 700; color: var(--primary); letter-spacing: -0.5px; }
#logo span { color: var(--text); }
.spacer { flex: 1; }
#scheduler-label { font-size: 12px; color: var(--muted); }
#scheduler-toggle {
  display: flex; align-items: center; gap: 8px;
  background: var(--sidebar); border: 1px solid var(--border); border-radius: 20px;
  padding: 4px 12px; cursor: pointer; transition: border-color .2s;
}
#scheduler-toggle:hover { border-color: var(--primary); }
#sched-pill {
  width: 32px; height: 18px; border-radius: 9px; background: var(--border);
  position: relative; transition: background .2s;
}
#sched-pill.on { background: var(--primary); }
#sched-pill::after {
  content:""; position:absolute; top:2px; left:2px;
  width:14px; height:14px; border-radius:50%; background:#fff;
  transition: transform .2s;
}
#sched-pill.on::after { transform: translateX(14px); }
#sched-text { font-size: 12px; font-weight: 600; color: var(--muted); }
#sched-text.on { color: var(--primary); }
#status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); }

/* ── Body ── */
#body { display: flex; flex: 1; overflow: hidden; }

/* ── Sidebar ── */
#sidebar {
  width: var(--sidebar-w); background: var(--sidebar);
  border-right: 1px solid var(--border); flex-shrink: 0;
  display: flex; flex-direction: column; padding: 16px 0;
  overflow-y: auto;
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 20px; cursor: pointer; border-radius: 8px;
  margin: 2px 8px; color: var(--muted); font-weight: 500;
  transition: background .15s, color .15s; user-select: none;
}
.nav-item:hover { background: rgba(255,255,255,0.05); color: var(--text); }
.nav-item.active { background: rgba(124,58,237,0.15); color: var(--primary); }
.nav-icon { font-size: 16px; width: 20px; text-align: center; }

/* ── Main ── */
#main { flex: 1; overflow-y: auto; padding: 24px; }

/* ── Section ── */
.section { display: none; animation: fadeIn .3s ease; }
.section.active { display: block; }
@keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }

/* ── Page title ── */
.page-title { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
.page-title .sub { font-size: 13px; color: var(--muted); font-weight: 400; margin-left: 8px; }

/* ── Stats row ── */
.stats-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
.stat-card {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px 20px; min-width: 140px; flex: 1;
}
.stat-card .val { font-size: 28px; font-weight: 700; color: var(--primary); }
.stat-card .lbl { font-size: 12px; color: var(--muted); margin-top: 4px; }

/* ── Card ── */
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px; margin-bottom: 20px;
}
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text); }

/* ── Table ── */
.tbl-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 8px 12px; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid var(--border); }
td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; vertical-align: middle; }
tr:hover td { background: rgba(255,255,255,0.02); }
.url-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cyan); }
.badge {
  display: inline-flex; align-items: center; padding: 2px 8px;
  border-radius: 20px; font-size: 11px; font-weight: 600;
}
.badge-gemini  { background: rgba(124,58,237,0.2); color: var(--primary); }
.badge-tfidf   { background: rgba(245,158,11,0.2); color: var(--warning); }
.badge-draft   { background: rgba(255,255,255,0.08); color: var(--muted); }
.badge-ok      { background: rgba(16,185,129,0.2); color: var(--success); }
.del-btn {
  background: none; border: 1px solid rgba(239,68,68,0.3); color: var(--error);
  padding: 3px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
  transition: background .15s;
}
.del-btn:hover { background: rgba(239,68,68,0.15); }

/* ── Add TikTok bar ── */
.add-bar { display: flex; gap: 8px; margin-top: 16px; }
.add-bar input { flex: 1; }

/* ── Inputs ── */
input[type=text], input[type=password], input[type=url], select, textarea {
  background: rgba(255,255,255,0.05); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); padding: 9px 12px; font-size: 14px;
  outline: none; transition: border-color .2s; width: 100%;
}
input:focus, select:focus, textarea:focus { border-color: var(--primary); }
input::placeholder { color: var(--muted); }
label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
.form-row { margin-bottom: 16px; }

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 18px; border-radius: 8px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: none; transition: background .15s, opacity .15s;
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-h); }
.btn-success { background: var(--success); color: #fff; }
.btn-success:hover:not(:disabled) { background: #0ea473; }
.btn-outline {
  background: none; border: 1px solid var(--border); color: var(--text);
}
.btn-outline:hover:not(:disabled) { background: rgba(255,255,255,0.05); }
.btn-lg { padding: 12px 28px; font-size: 16px; width: 100%; justify-content: center; margin-top: 8px; }

/* ── Log panel ── */
.log-panel {
  background: #07070d; border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; font-family: "Consolas","Cascadia Code","Fira Code",monospace;
  font-size: 12px; line-height: 1.6; max-height: 320px; overflow-y: auto;
  margin-top: 16px;
}
.log-panel.tall { max-height: 600px; }
.log-line { padding: 1px 0; animation: slideIn .2s ease; }
@keyframes slideIn { from { opacity:0; transform:translateX(-4px); } to { opacity:1; transform:none; } }
.log-line.ok      { color: var(--success); }
.log-line.err     { color: var(--error); }
.log-line.warn    { color: var(--warning); }
.log-line.info    { color: var(--cyan); }
.log-line.step    { color: #60a5fa; }
.log-line.ai      { color: #c084fc; }
.log-line.dim     { color: var(--muted); }

/* ── Spinner ── */
.spinner {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
  border-radius: 50%; animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Slide cards ── */
.slides-row { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
.slide-card {
  background: var(--sidebar); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px; flex: 0 0 calc(33.333% - 8px); min-width: 200px;
}
.slide-card .slide-n { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
.slide-card .slide-h { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
.slide-card .slide-b { font-size: 12px; color: var(--muted); line-height: 1.5; }
.slide-thumb { width: 100%; height: 120px; object-fit: cover; border-radius: 8px; margin-top: 8px; }

/* ── Thumbnails in Posts table ── */
.thumb-row { display: flex; gap: 4px; }
.thumb-row img { width: 36px; height: 36px; object-fit: cover; border-radius: 4px; }

/* ── Empty state ── */
.empty { text-align: center; padding: 48px; color: var(--muted); }
.empty .icon { font-size: 40px; margin-bottom: 12px; }

/* ── Settings grid ── */
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 720px) { .settings-grid { grid-template-columns: 1fr; } }

/* ── Responsive sidebar ── */
@media (max-width: 640px) {
  :root { --sidebar-w: 60px; }
  .nav-item span { display: none; }
  .nav-item { justify-content: center; }
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

/* ── Tag ── */
.tag-cyan { color: var(--cyan); }

/* ── Analytics ── */
.matrix-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
.matrix-card { border-radius: var(--radius); padding: 16px; border: 1px solid var(--border); }
.matrix-card .m-title { font-size: 13px; font-weight: 700; margin-bottom: 6px; }
.matrix-card .m-action { font-size: 12px; color: var(--muted); }
.matrix-card.scale    { background: rgba(16,185,129,0.1);  border-color: rgba(16,185,129,0.35); }
.matrix-card.fix-cta  { background: rgba(6,182,212,0.1);   border-color: rgba(6,182,212,0.35); }
.matrix-card.fix-hook { background: rgba(124,58,237,0.1);  border-color: rgba(124,58,237,0.35); }
.matrix-card.reset    { background: rgba(239,68,68,0.1);   border-color: rgba(239,68,68,0.35); }
.m-posts { margin-top: 8px; font-size: 11px; color: var(--muted); line-height: 1.7; }
.chart-wrap { position: relative; height: 200px; margin-top: 12px; }
canvas.chart { display: block; width: 100% !important; height: 100% !important; }

/* ── Mobile hamburger ── */
#hamburger {
  display: none; background: none; border: none; color: var(--text);
  font-size: 22px; cursor: pointer; padding: 4px 8px; line-height: 1;
  align-items: center; justify-content: center;
}
#overlay {
  display: none; position: fixed; inset: 56px 0 0 0;
  background: rgba(0,0,0,0.55); z-index: 99;
}
#overlay.show { display: block; }

@media (max-width: 680px) {
  #hamburger { display: flex; }
  :root { --sidebar-w: 240px; }
  .nav-item span { display: inline; }
  .nav-item { justify-content: flex-start; }
  #sidebar {
    position: fixed; top: 56px; left: 0; bottom: 0; z-index: 100;
    transform: translateX(-100%); transition: transform .25s ease;
  }
  #sidebar.open { transform: translateX(0); box-shadow: 4px 0 24px rgba(0,0,0,0.5); }
  #main { padding: 16px 12px; }
  .page-title { font-size: 18px; }
  .stat-card .val { font-size: 22px; }
  .stats-row { gap: 10px; }
  .stat-card { min-width: 110px; padding: 12px 14px; }
  .settings-grid { grid-template-columns: 1fr !important; }
  .matrix-grid { grid-template-columns: 1fr; }
  .btn-lg { font-size: 14px; padding: 11px 18px; }
  .slide-card { flex: 0 0 calc(50% - 6px); }
  table { font-size: 12px; }
  th, td { padding: 8px 8px; }
}
</style>
</head>
<body>
<div id="app">

  <!-- Topbar -->
  <header id="topbar">
    <button id="hamburger" onclick="toggleSidebar()" aria-label="Menu">☰</button>
    <div id="logo">🎯 <span>larry</span></div>
    <div class="spacer"></div>
    <span id="scheduler-label">Scheduler</span>
    <div id="scheduler-toggle" onclick="toggleScheduler()">
      <div id="sched-pill"></div>
      <span id="sched-text">OFF</span>
    </div>
    <div id="status-dot" title="Dashboard online"></div>
  </header>

  <div id="overlay" onclick="closeSidebar()"></div>
  <div id="body">
    <!-- Sidebar -->
    <nav id="sidebar">
      <div class="nav-item active" data-section="tiktoks" onclick="nav(this)">
        <span class="nav-icon">📹</span><span>TikToks</span>
      </div>
      <div class="nav-item" data-section="create" onclick="nav(this)">
        <span class="nav-icon">✨</span><span>Create Post</span>
      </div>
      <div class="nav-item" data-section="posts" onclick="nav(this)">
        <span class="nav-icon">📋</span><span>Posts</span>
      </div>
      <div class="nav-item" data-section="settings" onclick="nav(this)">
        <span class="nav-icon">⚙️</span><span>Settings</span>
      </div>
      <div class="nav-item" data-section="analytics" onclick="nav(this)">
        <span class="nav-icon">📊</span><span>Analytics</span>
      </div>
      <div class="nav-item" data-section="logs" onclick="nav(this)">
        <span class="nav-icon">🖥️</span><span>Logs</span>
      </div>
    </nav>

    <!-- Main -->
    <main id="main">

      <!-- TikToks Section -->
      <section id="sec-tiktoks" class="section active">
        <div class="page-title">TikToks <span class="sub">Your content library</span></div>
        <div class="stats-row">
          <div class="stat-card"><div class="val" id="stat-tiktoks">—</div><div class="lbl">Total TikToks</div></div>
          <div class="stat-card"><div class="val" id="stat-posts">—</div><div class="lbl">Total Posts</div></div>
          <div class="stat-card"><div class="val" id="stat-sched">OFF</div><div class="lbl">Scheduler</div></div>
        </div>
        <div class="card">
          <div class="card-title">Content Library</div>
          <div class="tbl-wrap">
            <table id="tiktoks-table">
              <thead>
                <tr>
                  <th>URL</th><th>Topic</th><th>Date Added</th><th>Embedding</th><th></th>
                </tr>
              </thead>
              <tbody id="tiktoks-tbody">
                <tr><td colspan="5" class="empty"><div class="icon">📹</div>Loading…</td></tr>
              </tbody>
            </table>
          </div>
          <div class="add-bar">
            <input type="url" id="add-url" placeholder="https://www.tiktok.com/@user/video/..." />
            <button class="btn btn-primary" id="add-btn" onclick="addTikTok()">
              <span id="add-btn-inner">Add</span>
            </button>
          </div>
          <div id="add-log" class="log-panel" style="display:none"></div>
        </div>
      </section>

      <!-- Create Section -->
      <section id="sec-create" class="section">
        <div class="page-title">Create Post <span class="sub">Generate a carousel</span></div>
        <div class="card">
          <div class="card-title">Generation Settings</div>
          <div class="settings-grid">
            <div class="form-row">
              <label>Account Name</label>
              <input type="text" id="create-account" value="default" />
            </div>
            <div class="form-row">
              <label>Topic Hint <span style="color:var(--muted)">(optional)</span></label>
              <input type="text" id="create-topic" placeholder="e.g. productivity tips" />
            </div>
          </div>
          <button class="btn btn-primary btn-lg" id="gen-btn" onclick="generatePost()">
            <span id="gen-btn-inner">✨ Generate Carousel</span>
          </button>
        </div>
        <div id="create-log" class="log-panel" style="display:none"></div>
        <div id="slides-container"></div>
      </section>

      <!-- Posts Section -->
      <section id="sec-posts" class="section">
        <div class="page-title">Posts <span class="sub">Created carousels</span></div>
        <div id="posts-by-account"></div>
      </section>

      <!-- Settings Section -->
      <section id="sec-settings" class="section">
        <div class="page-title">Settings <span class="sub">API keys & config</span></div>
        <div class="card">
          <div class="card-title">API Keys</div>
          <div class="settings-grid">
            <div class="form-row">
              <label>Gemini API Key</label>
              <input type="password" id="cfg-gemini" placeholder="Enter new value…" />
              <div id="cfg-gemini-cur" style="font-size:11px;color:var(--muted);margin-top:4px"></div>
            </div>
            <div class="form-row">
              <label>Imgur Client ID</label>
              <input type="password" id="cfg-imgur" placeholder="Enter new value…" />
              <div id="cfg-imgur-cur" style="font-size:11px;color:var(--muted);margin-top:4px"></div>
            </div>
            <div class="form-row">
              <label>TikTok Client Key</label>
              <input type="text" id="cfg-ttkey" placeholder="Enter new value…" />
              <div id="cfg-ttkey-cur" style="font-size:11px;color:var(--muted);margin-top:4px"></div>
            </div>
            <div class="form-row">
              <label>TikTok Client Secret</label>
              <input type="password" id="cfg-ttsecret" placeholder="Enter new value…" />
              <div id="cfg-ttsecret-cur" style="font-size:11px;color:var(--muted);margin-top:4px"></div>
            </div>
          </div>
          <div class="form-row" style="max-width:200px">
            <label>Schedule Time (HH:MM)</label>
            <input type="text" id="cfg-sched" placeholder="16:00" />
          </div>
          <div style="display:flex;gap:12px;margin-top:8px">
            <button class="btn btn-primary" onclick="saveConfig()">💾 Save Settings</button>
            <button class="btn btn-outline" onclick="authTikTok()">🔗 Authorize TikTok</button>
          </div>
          <div id="settings-msg" style="margin-top:12px;font-size:13px"></div>
        </div>
      </section>

      <!-- Analytics Section -->
      <section id="sec-analytics" class="section">
        <div class="page-title">Analytics <span class="sub">Post performance by account</span></div>
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap">
          <button class="btn btn-primary" id="refresh-btn" onclick="refreshAnalytics()">
            <span id="refresh-inner">🔄 Refresh from TikTok</span>
          </button>
          <span id="analytics-status" style="font-size:12px;color:var(--muted)"></span>
        </div>
        <!-- Overall totals -->
        <div class="stats-row" id="an-totals-row">
          <div class="stat-card"><div class="val" id="an-views">—</div><div class="lbl">Total Views</div></div>
          <div class="stat-card"><div class="val" id="an-likes">—</div><div class="lbl">Total Likes</div></div>
          <div class="stat-card"><div class="val" id="an-comments">—</div><div class="lbl">Total Comments</div></div>
          <div class="stat-card"><div class="val" id="an-eng">—</div><div class="lbl">Avg Engagement</div></div>
        </div>
        <!-- Per-account sections rendered by JS -->
        <div id="analytics-by-account"></div>
      </section>

      <!-- Logs Section -->
      <section id="sec-logs" class="section">
        <div class="page-title">
          Activity Log
          <button class="btn btn-outline" style="margin-left:16px;font-size:12px;padding:5px 12px" onclick="clearLogs()">Clear</button>
        </div>
        <div id="live-log" class="log-panel tall"></div>
      </section>

    </main>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────────
let schedulerOn = false;

// ── Navigation ─────────────────────────────────────────────────────────────────
function nav(el) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  el.classList.add("active");
  const sec = el.dataset.section;
  document.getElementById("sec-" + sec).classList.add("active");
  if (sec === "tiktoks")   loadDB();
  if (sec === "posts")     loadDB();
  if (sec === "settings")  loadSettings();
  if (sec === "analytics") loadAnalytics();
  closeSidebar();
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("overlay").classList.toggle("show");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("show");
}

// ── DB / data ──────────────────────────────────────────────────────────────────
async function loadDB() {
  const res = await fetch("/api/db");
  const db  = await res.json();
  renderTikToks(db.tiktoks || []);
  renderPosts(db.posts || []);
  document.getElementById("stat-tiktoks").textContent = (db.tiktoks || []).length;
  document.getElementById("stat-posts").textContent   = (db.posts || []).length;
}

function renderTikToks(tiktoks) {
  const tbody = document.getElementById("tiktoks-tbody");
  if (!tiktoks.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="icon">📹</div>No TikToks yet. Add one below!</div></td></tr>';
    return;
  }
  tbody.innerHTML = tiktoks.map(t => {
    const url   = t.url || "";
    const short = url.length > 45 ? url.slice(0, 42) + "…" : url;
    const topic = (t.topic || t.transcript || "").slice(0, 60) || "—";
    const date  = t.addedAt ? new Date(t.addedAt).toLocaleDateString() : "—";
    const emb   = t.embeddingType === "gemini"
      ? '<span class="badge badge-gemini">Gemini</span>'
      : '<span class="badge badge-tfidf">TF-IDF</span>';
    return \`<tr>
      <td><a class="url-cell" href="\${url}" target="_blank" title="\${url}">\${short}</a></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${topic}</td>
      <td>\${date}</td>
      <td>\${emb}</td>
      <td><button class="del-btn" onclick="deleteTikTok('\${t.id}')">✕ Delete</button></td>
    </tr>\`;
  }).join("");
}

function renderPosts(posts) {
  const container = document.getElementById("posts-by-account");
  if (!posts.length) {
    container.innerHTML = \`<div class="card"><div class="empty"><div class="icon">📋</div>No posts yet. Create one in the Create Post tab.</div></div>\`;
    return;
  }

  // Group posts by account, sorted newest first within each group
  const groups = {};
  for (const p of [...posts].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const acct = p.account || "default";
    if (!groups[acct]) groups[acct] = [];
    groups[acct].push(p);
  }

  container.innerHTML = Object.entries(groups).map(([account, acctPosts]) => {
    const total     = acctPosts.length;
    const published = acctPosts.filter(p => p.publishId).length;

    const rows = acctPosts.map(p => {
      const date   = p.createdAt ? new Date(p.createdAt).toLocaleString() : "—";
      const slides = (p.slides || []).length;
      const status = p.publishId
        ? \`<span class="badge badge-ok">✓ Uploaded</span>\`
        : \`<span class="badge badge-draft">Draft</span>\`;
      const pid    = p.publishId
        ? \`<span style="font-size:11px;color:var(--muted)" title="\${p.publishId}">\${p.publishId.slice(0,18)}…</span>\`
        : \`<span style="color:var(--muted);font-size:11px">—</span>\`;
      const thumbs = (p.imageUrls || []).slice(0, 4).map(u =>
        \`<img src="\${u}" loading="lazy" onerror="this.style.display='none'">\`
      ).join("");
      return \`<tr>
        <td>\${date}</td>
        <td>\${slides}</td>
        <td>\${status}</td>
        <td>\${pid}</td>
        <td><div class="thumb-row">\${thumbs}</div></td>
      </tr>\`;
    }).join("");

    return \`
      <div class="card" style="margin-bottom:20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
          <div>
            <div class="card-title" style="margin-bottom:2px">📱 \${account}</div>
            <div style="font-size:12px;color:var(--muted)">\${total} post\${total !== 1 ? "s" : ""} · \${published} uploaded</div>
          </div>
          <div style="display:flex;gap:8px">
            <span class="badge badge-ok">\${published} uploaded</span>
            <span class="badge badge-draft">\${total - published} draft</span>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr><th>Date</th><th>Slides</th><th>Status</th><th>TikTok ID</th><th>Preview</th></tr>
            </thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>
      </div>
    \`;
  }).join("");
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const res  = await fetch("/api/config");
  const cfg  = await res.json();
  const show = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val ? "Current: " + val : "";
  };
  show("cfg-gemini-cur",   cfg.geminiKeyMasked);
  show("cfg-imgur-cur",    cfg.imgurClientIdMasked);
  show("cfg-ttkey-cur",    cfg.tiktokClientKeyMasked);
  show("cfg-ttsecret-cur", cfg.tiktokClientSecretMasked);
  document.getElementById("cfg-sched").value = cfg.scheduleTime || "16:00";
}

async function saveConfig() {
  const body = {};
  const g  = document.getElementById("cfg-gemini").value.trim();
  const im = document.getElementById("cfg-imgur").value.trim();
  const tk = document.getElementById("cfg-ttkey").value.trim();
  const ts = document.getElementById("cfg-ttsecret").value.trim();
  const sc = document.getElementById("cfg-sched").value.trim();
  if (g)  body.geminiKey          = g;
  if (im) body.imgurClientId      = im;
  if (tk) body.tiktokClientKey    = tk;
  if (ts) body.tiktokClientSecret = ts;
  if (sc) body.scheduleTime       = sc;
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const msg = document.getElementById("settings-msg");
  if (res.ok) {
    msg.style.color = "var(--success)";
    msg.textContent = "✓ Settings saved.";
    loadSettings();
  } else {
    msg.style.color = "var(--error)";
    msg.textContent = "✗ Failed to save.";
  }
  setTimeout(() => msg.textContent = "", 3000);
}

function authTikTok() {
  window.open("/api/auth/tiktok", "_blank");
}

// ── Add TikTok ────────────────────────────────────────────────────────────────
function addTikTok() {
  const url = document.getElementById("add-url").value.trim();
  if (!url) return;
  const btn     = document.getElementById("add-btn");
  const inner   = document.getElementById("add-btn-inner");
  const logEl   = document.getElementById("add-log");
  btn.disabled  = true;
  inner.innerHTML = '<span class="spinner"></span> Adding…';
  logEl.style.display = "block";
  logEl.innerHTML = "";

  fetch("/api/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  }).then(res => {
    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = "";
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const d = JSON.parse(part.slice(5).trim());
            if (d.line) appendLogLine(logEl, d.line);
            if (d.done) {
              btn.disabled = false;
              inner.textContent = "Add";
              document.getElementById("add-url").value = "";
              setTimeout(loadDB, 800);
            }
          } catch {}
        }
        pump();
      });
    }
    pump();
  }).catch(err => {
    appendLogLine(logEl, "[✗] " + err.message);
    btn.disabled = false;
    inner.textContent = "Add";
  });
}

// ── Generate Post ─────────────────────────────────────────────────────────────
function generatePost() {
  const account  = document.getElementById("create-account").value.trim() || "default";
  const topic    = document.getElementById("create-topic").value.trim();
  const btn      = document.getElementById("gen-btn");
  const inner    = document.getElementById("gen-btn-inner");
  const logEl    = document.getElementById("create-log");
  const slidesEl = document.getElementById("slides-container");
  btn.disabled   = true;
  inner.innerHTML = '<span class="spinner"></span> Generating…';
  logEl.style.display = "block";
  logEl.innerHTML = "";
  slidesEl.innerHTML = "";

  const rawLines = [];

  fetch("/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, topic }),
  }).then(res => {
    const reader = res.body.getReader();
    const dec    = new TextDecoder();
    let buf = "";
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) return;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith("data:")) continue;
          try {
            const d = JSON.parse(part.slice(5).trim());
            if (d.line) { appendLogLine(logEl, d.line); rawLines.push(d.line); }
            if (d.done) {
              btn.disabled = false;
              inner.textContent = "✨ Generate Carousel";
              renderSlides(rawLines, slidesEl);
              setTimeout(() => { loadDB(); loadAnalytics(); }, 1200);
            }
          } catch {}
        }
        pump();
      });
    }
    pump();
  }).catch(err => {
    appendLogLine(logEl, "[✗] " + err.message);
    btn.disabled = false;
    inner.textContent = "✨ Generate Carousel";
  });
}

function renderSlides(lines, container) {
  // Try to parse slide data from output lines
  const slideData = [];
  let current = null;
  for (const line of lines) {
    const clean = line.replace(/\\x1b\\[[0-9;]*m/g, "").trim();
    const slideMatch = clean.match(/^(?:Slide|SLIDE)\\s*(\\d+)[:\\s-]*(.*)$/i);
    const headlineMatch = clean.match(/^(?:headline|title)[:\\s]+(.+)$/i);
    const bodyMatch = clean.match(/^(?:body|text|caption)[:\\s]+(.+)$/i);
    if (slideMatch) {
      if (current) slideData.push(current);
      current = { n: slideMatch[1], headline: slideMatch[2] || "", body: "" };
    } else if (headlineMatch && current) {
      current.headline = headlineMatch[1];
    } else if (bodyMatch && current) {
      current.body = bodyMatch[1];
    }
  }
  if (current) slideData.push(current);

  if (!slideData.length) return;

  container.innerHTML = \`
    <div class="card">
      <div class="card-title">Generated Slides (\${slideData.length})</div>
      <div class="slides-row">
        \${slideData.map(s => \`
          <div class="slide-card">
            <div class="slide-n">Slide \${s.n}</div>
            <div class="slide-h">\${s.headline || "—"}</div>
            \${s.body ? \`<div class="slide-b">\${s.body}</div>\` : ""}
          </div>
        \`).join("")}
      </div>
    </div>
  \`;
}

// ── Delete TikTok ─────────────────────────────────────────────────────────────
async function deleteTikTok(id) {
  if (!confirm("Delete this TikTok from the database?")) return;
  const res = await fetch("/api/tiktok/" + encodeURIComponent(id), { method: "DELETE" });
  if (res.ok) loadDB();
  else alert("Failed to delete.");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
async function toggleScheduler() {
  const res  = await fetch("/api/schedule/toggle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  schedulerOn = data.on;
  updateSchedulerUI();
}

function updateSchedulerUI() {
  const pill  = document.getElementById("sched-pill");
  const text  = document.getElementById("sched-text");
  const stat  = document.getElementById("stat-sched");
  if (schedulerOn) {
    pill.classList.add("on");
    text.classList.add("on");
    text.textContent = "ON";
    if (stat) stat.textContent = "ON";
  } else {
    pill.classList.remove("on");
    text.classList.remove("on");
    text.textContent = "OFF";
    if (stat) stat.textContent = "OFF";
  }
}

// ── Log panel helpers ─────────────────────────────────────────────────────────
function classifyLine(line) {
  const clean = line.replace(/\\x1b\\[[0-9;]*m/g, "");
  if (clean.includes("[✓]") || clean.includes("[ok]")) return "ok";
  if (clean.includes("[✗]") || clean.includes("[error]")) return "err";
  if (clean.includes("[!]") || clean.includes("[warn]")) return "warn";
  if (clean.includes("[larry]")) return "info";
  if (clean.includes("[→]") || clean.includes("[step]")) return "step";
  if (clean.includes("[ai]")) return "ai";
  return "dim";
}

function stripAnsi(str) {
  return str.replace(/\\x1b\\[[0-9;]*m/g, "");
}

function appendLogLine(el, line) {
  const cls  = classifyLine(line);
  const div  = document.createElement("div");
  div.className = "log-line " + cls;
  div.textContent = stripAnsi(line).replace(/\\n$/, "");
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;

  // Also push to live log
  const liveLog = document.getElementById("live-log");
  if (liveLog) {
    const div2 = document.createElement("div");
    div2.className = "log-line " + cls;
    div2.textContent = stripAnsi(line).replace(/\\n$/, "");
    liveLog.appendChild(div2);
    liveLog.scrollTop = liveLog.scrollHeight;
  }
}

// ── Live log SSE ──────────────────────────────────────────────────────────────
function connectLogSSE() {
  const es = new EventSource("/api/logs");
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      const liveLog = document.getElementById("live-log");
      if (liveLog && d.line) {
        const cls  = classifyLine(d.line);
        const div  = document.createElement("div");
        div.className = "log-line " + cls;
        div.textContent = stripAnsi(d.line).replace(/\\n$/, "");
        liveLog.appendChild(div);
        liveLog.scrollTop = liveLog.scrollHeight;
      }
    } catch {}
  };
  es.onerror = () => setTimeout(connectLogSSE, 5000);
}

function clearLogs() {
  const el = document.getElementById("live-log");
  if (el) el.innerHTML = "";
  fetch("/api/logs/clear", { method: "POST" });
}

// ── Analytics ─────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const res    = await fetch("/api/analytics");
  const data   = await res.json();
  const posts  = data.posts || [];
  const pending = posts.filter(p => p.analytics && p.analytics.views == null).length;
  const status  = document.getElementById("analytics-status");
  if (status) {
    status.textContent = pending > 0
      ? \`\${pending} post\${pending !== 1 ? "s" : ""} waiting for TikTok data — click Refresh\`
      : posts.length ? "All posts loaded" : "";
  }
  renderAnalytics(data);
}

async function refreshAnalytics() {
  const btn    = document.getElementById("refresh-btn");
  const inner  = document.getElementById("refresh-inner");
  const status = document.getElementById("analytics-status");
  btn.disabled = true;
  inner.innerHTML = '<span class="spinner"></span> Fetching…';
  status.textContent = "";
  try {
    const res  = await fetch("/api/analytics/refresh", { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      status.textContent = "✓ Updated " + new Date().toLocaleTimeString();
      renderAnalytics(data);
    } else {
      status.textContent = "✗ " + (data.error || "Failed — check TikTok auth");
    }
  } catch(e) {
    status.textContent = "✗ " + e.message;
  } finally {
    btn.disabled = false;
    inner.textContent = "🔄 Refresh from TikTok";
  }
}

function fmtNum(n) {
  if (n == null || n === "") return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function renderAnalytics(data) {
  const posts    = data.posts || [];
  const withData = posts.filter(p => p.analytics);

  // ── Overall totals ────────────────────────────────────────────────────────
  let totalViews = 0, totalLikes = 0, totalComments = 0;
  for (const p of withData) {
    totalViews    += p.analytics.views    || 0;
    totalLikes    += p.analytics.likes    || 0;
    totalComments += p.analytics.comments || 0;
  }
  const avgEng = withData.length && totalViews
    ? ((totalLikes / totalViews) * 100).toFixed(1) + "%"
    : "—";
  document.getElementById("an-views").textContent    = fmtNum(totalViews);
  document.getElementById("an-likes").textContent    = fmtNum(totalLikes);
  document.getElementById("an-comments").textContent = fmtNum(totalComments);
  document.getElementById("an-eng").textContent      = avgEng;

  // ── Group by account ──────────────────────────────────────────────────────
  const container = document.getElementById("analytics-by-account");
  if (!posts.length) {
    container.innerHTML = \`<div class="card"><div class="empty"><div class="icon">📊</div>No posts yet. Create one first, then click Refresh.</div></div>\`;
    return;
  }

  const groups = {};
  for (const p of posts) {
    const acct = p.account || "default";
    if (!groups[acct]) groups[acct] = [];
    groups[acct].push(p);
  }

  // Collect canvas IDs so we can draw after innerHTML is set
  const canvasJobs = [];

  container.innerHTML = Object.entries(groups).map(([account, acctPosts]) => {
    const acctWith = acctPosts.filter(p => p.analytics);
    let aViews = 0, aLikes = 0, aComments = 0;
    for (const p of acctWith) {
      aViews    += p.analytics.views    || 0;
      aLikes    += p.analytics.likes    || 0;
      aComments += p.analytics.comments || 0;
    }
    const aEng = acctWith.length && aViews
      ? ((aLikes / aViews) * 100).toFixed(1) + "%"
      : "—";

    // Per-account median for diagnostic
    const vVals = acctWith.map(p => p.analytics.views || 0).sort((a,b) => a-b);
    const lVals = acctWith.map(p => p.analytics.likes || 0).sort((a,b) => a-b);
    const medV  = vVals.length ? vVals[Math.floor(vVals.length / 2)] : 0;
    const medL  = lVals.length ? lVals[Math.floor(lVals.length / 2)] : 0;

    const matrix = { scale: [], fixcta: [], fixhook: [], reset: [] };

    const rows = [...acctPosts]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map(p => {
        const an   = p.analytics || {};
        const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";
        const v    = an.views    != null ? an.views    : null;
        const l    = an.likes    != null ? an.likes    : null;
        const c    = an.comments != null ? an.comments : null;
        const s    = an.shares   != null ? an.shares   : null;

        let diag = '<span style="color:var(--muted);font-size:11px">—</span>';
        if (v != null && l != null && acctWith.length >= 2) {
          const hiV = v >= medV, hiL = l >= medL;
          const lbl = date;
          if      (hiV && hiL) { diag = '<span class="badge badge-ok">Scale</span>';                                                          matrix.scale.push(lbl); }
          else if (hiV)        { diag = '<span class="badge" style="background:rgba(6,182,212,.2);color:var(--cyan)">Fix CTA</span>';          matrix.fixcta.push(lbl); }
          else if (hiL)        { diag = '<span class="badge badge-gemini">Fix Hook</span>';                                                    matrix.fixhook.push(lbl); }
          else                 { diag = '<span class="badge badge-tfidf">Reset</span>';                                                        matrix.reset.push(lbl); }
        }

        const pending = v == null
          ? \`<span class="badge badge-draft" style="font-size:10px">Pending</span>\`
          : null;
        return \`<tr>
          <td>\${date}</td>
          <td>\${pending || fmtNum(v)}</td>
          <td>\${pending ? "" : fmtNum(l)}</td>
          <td>\${pending ? "" : fmtNum(c)}</td>
          <td>\${pending ? "" : fmtNum(s)}</td>
          <td>\${diag}</td>
        </tr>\`;
      }).join("");

    const canvasId = \`chart-\${account.replace(/[^a-z0-9]/gi,"_")}\`;
    canvasJobs.push({ canvasId, posts: acctPosts });

    const matrixHtml = \`
      <div class="matrix-grid" style="margin-top:0">
        <div class="matrix-card scale">
          <div class="m-title">📈 High Views · High Likes</div>
          <div class="m-action">Scale — make 3 variations immediately</div>
          <div class="m-posts">\${matrix.scale.length ? matrix.scale.join(" · ") : "No posts yet"}</div>
        </div>
        <div class="matrix-card fix-cta">
          <div class="m-title">👀 High Views · Low Likes</div>
          <div class="m-action">Fix CTA — hook works, conversion broken</div>
          <div class="m-posts">\${matrix.fixcta.length ? matrix.fixcta.join(" · ") : "No posts yet"}</div>
        </div>
        <div class="matrix-card fix-hook">
          <div class="m-title">❤️ Low Views · High Likes</div>
          <div class="m-action">Fix hooks — content converts, needs visibility</div>
          <div class="m-posts">\${matrix.fixhook.length ? matrix.fixhook.join(" · ") : "No posts yet"}</div>
        </div>
        <div class="matrix-card reset">
          <div class="m-title">💀 Low Views · Low Likes</div>
          <div class="m-action">Full reset — try different format/audience</div>
          <div class="m-posts">\${matrix.reset.length ? matrix.reset.join(" · ") : "No posts yet"}</div>
        </div>
      </div>\`;

    return \`
      <div class="card" style="margin-bottom:24px">
        <!-- Account header -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-size:17px;font-weight:700">📱 \${account}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">\${acctPosts.length} post\${acctPosts.length!==1?"s":""}</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="stat-card" style="min-width:90px;padding:10px 14px">
              <div class="val" style="font-size:20px">\${fmtNum(aViews)}</div><div class="lbl">Views</div>
            </div>
            <div class="stat-card" style="min-width:90px;padding:10px 14px">
              <div class="val" style="font-size:20px">\${fmtNum(aLikes)}</div><div class="lbl">Likes</div>
            </div>
            <div class="stat-card" style="min-width:90px;padding:10px 14px">
              <div class="val" style="font-size:20px">\${aEng}</div><div class="lbl">Engagement</div>
            </div>
          </div>
        </div>

        <!-- Views chart -->
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text)">Views Over Time</div>
        <div class="chart-wrap" style="margin-bottom:20px">
          <canvas id="\${canvasId}" class="chart"></canvas>
        </div>

        <!-- Posts table -->
        <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--text)">Posts</div>
        <div class="tbl-wrap" style="margin-bottom:20px">
          <table>
            <thead><tr><th>Date</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Diagnosis</th></tr></thead>
            <tbody>\${rows}</tbody>
          </table>
        </div>

        <!-- Diagnostic matrix -->
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;color:var(--text)">🎯 Larry's Diagnostic Matrix</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Classified against this account's median performance</div>
        \${acctWith.length >= 2 ? matrixHtml : \`<div style="font-size:12px;color:var(--muted);padding:8px 0">Need at least 2 posts with data for diagnosis</div>\`}
      </div>
    \`;
  }).join("");

  // Draw charts after DOM is updated
  requestAnimationFrame(() => {
    for (const { canvasId, posts: p } of canvasJobs) {
      drawViewsChart(canvasId, p);
    }
  });
}

function drawViewsChart(canvasId, posts) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  canvas.width  = canvas.offsetWidth  || canvas.parentElement.offsetWidth;
  canvas.height = canvas.offsetHeight || 200;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;

  const points = posts
    .filter(p => p.analytics && p.analytics.views != null)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(p => ({ label: new Date(p.createdAt).toLocaleDateString(), v: p.analytics.views || 0 }));

  if (!points.length) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("No analytics data yet — click Refresh to fetch from TikTok", W / 2, H / 2);
    return;
  }

  const maxV = Math.max(...points.map(p => p.v), 1);
  const pad  = { top: 20, right: 20, bottom: 36, left: 52 };
  const cW   = W - pad.left - pad.right;
  const cH   = H - pad.top  - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (cH / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "10px system-ui"; ctx.textAlign = "right";
    ctx.fillText(fmtNum(Math.round(maxV * (1 - i / 4))), pad.left - 6, y + 4);
  }

  const step = points.length > 1 ? cW / (points.length - 1) : cW / 2;
  const toX  = i => pad.left + i * step;
  const toY  = v => pad.top + cH - (v / maxV) * cH;

  // Fill gradient
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
  grad.addColorStop(0, "rgba(124,58,237,0.35)");
  grad.addColorStop(1, "rgba(124,58,237,0)");
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0].v));
  for (let i = 1; i < points.length; i++) {
    const cpx = (toX(i - 1) + toX(i)) / 2;
    ctx.bezierCurveTo(cpx, toY(points[i-1].v), cpx, toY(points[i].v), toX(i), toY(points[i].v));
  }
  ctx.lineTo(toX(points.length - 1), pad.top + cH);
  ctx.lineTo(toX(0), pad.top + cH);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0].v));
  for (let i = 1; i < points.length; i++) {
    const cpx = (toX(i - 1) + toX(i)) / 2;
    ctx.bezierCurveTo(cpx, toY(points[i-1].v), cpx, toY(points[i].v), toX(i), toY(points[i].v));
  }
  ctx.strokeStyle = "#7c3aed"; ctx.lineWidth = 2.5; ctx.stroke();

  // Dots + X labels
  const labelStep = points.length > 10 ? Math.ceil(points.length / 8) : 1;
  for (let i = 0; i < points.length; i++) {
    ctx.beginPath();
    ctx.arc(toX(i), toY(points[i].v), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#7c3aed"; ctx.fill();
    ctx.strokeStyle = "#0a0a0f"; ctx.lineWidth = 2; ctx.stroke();
    if (i % labelStep === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = "9px system-ui"; ctx.textAlign = "center";
      ctx.fillText(points[i].label, toX(i), H - 8);
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadDB();
connectLogSSE();
</script>
</body>
</html>`;

// ─── Router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" });
    return res.end();
  }

  // ── GET / ──────────────────────────────────────────────────────────────────
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(HTML);
  }

  // ── GET /api/db ────────────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/db") {
    return sendJSON(res, 200, loadDB());
  }

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/config") {
    const cfg = loadConfig();
    return sendJSON(res, 200, {
      geminiKeyMasked:          maskKey(cfg.geminiKey),
      tiktokClientKeyMasked:    maskKey(cfg.tiktokClientKey),
      tiktokClientSecretMasked: maskKey(cfg.tiktokClientSecret),
      imgurClientIdMasked:      maskKey(cfg.imgurClientId),
      scheduleTime:             cfg.scheduleTime || "16:00",
    });
  }

  // ── POST /api/config ───────────────────────────────────────────────────────
  if (method === "POST" && url === "/api/config") {
    const body = await parseBody(req);
    const cfg  = loadConfig();
    const allowed = ["geminiKey","tiktokClientKey","tiktokClientSecret","imgurClientId","scheduleTime"];
    for (const k of allowed) {
      if (body[k] !== undefined && body[k] !== "") cfg[k] = body[k];
    }
    saveConfig(cfg);
    return sendJSON(res, 200, { ok: true });
  }

  // ── GET /api/logs (SSE) ────────────────────────────────────────────────────
  if (method === "GET" && url === "/api/logs") {
    sseHeaders(res);
    // Send existing buffered logs
    for (const entry of logLines) {
      sseWrite(res, { line: entry.line });
    }
    const fn = entry => sseWrite(res, { line: entry.line });
    logListeners.add(fn);
    req.on("close", () => logListeners.delete(fn));
    // keep alive
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ping); } }, 15000);
    req.on("close", () => clearInterval(ping));
    return;
  }

  // ── POST /api/logs/clear ───────────────────────────────────────────────────
  if (method === "POST" && url === "/api/logs/clear") {
    logLines.length = 0;
    return sendJSON(res, 200, { ok: true });
  }

  // ── POST /api/add (SSE stream) ─────────────────────────────────────────────
  if (method === "POST" && url === "/api/add") {
    const body = await parseBody(req);
    const addUrl = (body.url || "").trim();
    if (!addUrl) return sendJSON(res, 400, { error: "url required" });
    const cfg = loadConfig();
    spawnStream(res, ["add", addUrl], buildEnv(cfg));
    return;
  }

  // ── POST /api/create (SSE stream) ─────────────────────────────────────────
  if (method === "POST" && url === "/api/create") {
    const body = await parseBody(req);
    const cfg  = loadConfig();
    const args = ["create"];
    if (body.account) args.push("--account", body.account);
    if (body.topic)   args.push("--topic",   body.topic);
    spawnStream(res, args, buildEnv(cfg));
    return;
  }

  // ── POST /api/schedule/toggle ──────────────────────────────────────────────
  if (method === "POST" && url === "/api/schedule/toggle") {
    const body = await parseBody(req);
    if (schedulerOn) {
      stopScheduler();
    } else {
      const cfg  = loadConfig();
      startScheduler(body.time || cfg.scheduleTime || "16:00");
    }
    return sendJSON(res, 200, { on: schedulerOn });
  }

  // ── DELETE /api/tiktok/:id ─────────────────────────────────────────────────
  if (method === "DELETE" && url.startsWith("/api/tiktok/")) {
    const id = decodeURIComponent(url.slice("/api/tiktok/".length));
    const db = loadDB();
    const before = db.tiktoks.length;
    db.tiktoks = db.tiktoks.filter(t => t.id !== id);
    if (db.tiktoks.length === before) return sendJSON(res, 404, { error: "not found" });
    saveDB(db);
    pushLog(`[larry] Deleted TikTok: ${id}\n`);
    return sendJSON(res, 200, { ok: true });
  }

  // ── GET /api/auth/tiktok ───────────────────────────────────────────────────
  if (method === "GET" && url === "/api/auth/tiktok") {
    const cfg = loadConfig();
    const key = cfg.tiktokClientKey || "";
    if (!key) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("TikTok Client Key not configured. Set it in Settings first.");
    }
    const redirect = encodeURIComponent(`http://localhost:${PORT}/api/auth/tiktok/callback`);
    const scope = encodeURIComponent("user.info.basic,video.upload,video.publish");
    const authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${key}&scope=${scope}&response_type=code&redirect_uri=${redirect}&state=larry`;
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  // ── GET /api/auth/tiktok/callback ─────────────────────────────────────────
  if (method === "GET" && url.startsWith("/api/auth/tiktok/callback")) {
    const qs    = new URL("http://localhost" + url).searchParams;
    const code  = qs.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("No code in callback.");
    }
    // Spawn larry auth-callback (or just show the code)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><body style="background:#0a0a0f;color:#fff;font-family:system-ui;padding:40px">
      <h2>✓ TikTok OAuth Code Received</h2>
      <p>Code: <code style="background:#111;padding:4px 8px;border-radius:4px">${code}</code></p>
      <p>Run <code>node larry.js auth</code> in your terminal to complete authorization, or the dashboard will handle it automatically next cycle.</p>
      <script>setTimeout(()=>window.close(),5000);</script>
    </body></html>`);
    return;
  }

  // ── GET /api/analytics ────────────────────────────────────────────────────
  // Auto-initialises analytics entry for every post that doesn't have one yet,
  // so posts appear in the analytics page immediately after upload.
  if (method === "GET" && url === "/api/analytics") {
    const db = loadDB();
    let dirty = false;
    for (const post of (db.posts || [])) {
      if (!post.analytics) {
        post.analytics = {
          views: null, likes: null, comments: null, shares: null,
          history: [], initialized: true, lastFetched: null,
        };
        dirty = true;
      }
    }
    if (dirty) saveDB(db);
    return sendJSON(res, 200, db);
  }

  // ── POST /api/analytics/refresh ───────────────────────────────────────────
  if (method === "POST" && url === "/api/analytics/refresh") {
    const db  = loadDB();
    const cfg = loadConfig();
    const posts = db.posts || [];
    let updated = 0;
    const errors = [];

    for (const post of posts) {
      if (!post.publishId) continue;
      const accountName = post.account || "default";
      const accounts    = cfg.accounts || {};
      const token       = (accounts[accountName] || accounts["default"] || cfg).accessToken;
      if (!token) { errors.push(`No token for account: ${accountName}`); continue; }

      try {
        // TikTok Content Posting API — query video list for owned videos
        const apiRes = await fetch(
          "https://open.tiktokapis.com/v2/video/list/?fields=id,title,view_count,like_count,comment_count,share_count",
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!apiRes.ok) {
          errors.push(`TikTok API ${apiRes.status} for ${accountName}`);
          continue;
        }
        const apiData = await apiRes.json();
        const videos  = (apiData?.data?.videos) || [];

        // Match by publishId
        const match = videos.find(v => String(v.id) === String(post.publishId));
        if (match) {
          if (!post.analytics) post.analytics = { history: [] };
          post.analytics.views    = match.view_count    || 0;
          post.analytics.likes    = match.like_count    || 0;
          post.analytics.comments = match.comment_count || 0;
          post.analytics.shares   = match.share_count   || 0;
          post.analytics.lastFetched = Date.now();
          if (!post.analytics.history) post.analytics.history = [];
          post.analytics.history.push({
            t:     Date.now(),
            views: match.view_count || 0,
            likes: match.like_count || 0,
          });
          if (post.analytics.history.length > 30) post.analytics.history.shift();
          updated++;
        } else {
          // Video not yet indexed or not found — store zeros if no data
          if (!post.analytics) {
            post.analytics = { views: 0, likes: 0, comments: 0, shares: 0, history: [], lastFetched: Date.now() };
          }
        }
      } catch (err) {
        errors.push(`Fetch error: ${err.message}`);
      }
    }

    saveDB(db);
    pushLog(`[larry] Analytics refreshed — ${updated} updated, ${errors.length} errors\n`);
    if (errors.length) errors.forEach(e => pushLog(`[larry]   ${e}\n`));
    return sendJSON(res, 200, db);
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  sendJSON(res, 404, { error: "not found", path: url });
});

server.listen(PORT, "::", () => {
  const os   = require("os");
  const nets = os.networkInterfaces();
  const ipv4s = [], tsv6s = [], tsv4s = [];
  for (const [name, ifaces] of Object.entries(nets)) {
    for (const iface of ifaces) {
      if (iface.internal) continue;
      const isTailscale = name.toLowerCase().includes("tailscale");
      if (iface.family === "IPv4" && isTailscale) tsv4s.push(iface.address);
      else if (iface.family === "IPv6" && isTailscale && !iface.address.startsWith("fe80")) tsv6s.push(iface.address);
      else if (iface.family === "IPv4") ipv4s.push(iface.address);
    }
  }
  console.log(`\n[larry dashboard] ─────────────────────────────────`);
  console.log(`[larry dashboard] Local:     http://localhost:${PORT}`);
  if (ipv4s.length) console.log(`[larry dashboard] LAN:       http://${ipv4s[0]}:${PORT}`);
  if (tsv4s.length) console.log(`[larry dashboard] Tailscale: http://${tsv4s[0]}:${PORT}`);
  if (tsv6s.length) console.log(`[larry dashboard] Tailscale: http://[${tsv6s[0]}]:${PORT}`);
  console.log(`[larry dashboard] ─────────────────────────────────\n`);
});

// ── ipv6Only must be false for dual-stack (default on most platforms) ──────────
server.on("listening", () => {
  try { server._handle && server._handle.setSimultaneousAccepts && server._handle.setSimultaneousAccepts(true); } catch {}
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`[larry dashboard] Port ${PORT} already in use. Kill the existing process or change PORT.`);
  } else {
    console.error("[larry dashboard] Server error:", err);
  }
  process.exit(1);
});
