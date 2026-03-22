#!/usr/bin/env node
/**
 * ios-agent — Claude-powered iPhone automation agent
 *
 * Usage:
 *   node ios-agent-cli.js check                           verify setup
 *   node ios-agent-cli.js devices                         list connected iPhones
 *   node ios-agent-cli.js config                          show config
 *   node ios-agent-cli.js config --key KEY --value VAL    set config value
 *   node ios-agent-cli.js run --app Instagram --task "follow @someone"
 *   node ios-agent-cli.js run --app Safari --task "search for cats" --bundle com.apple.mobilesafari
 *   node ios-agent-cli.js setup                           interactive first-time setup
 *
 * Requires:
 *   - iPhone connected via USB with trust enabled
 *   - Appium running: appium (npm install -g appium && appium driver install xcuitest)
 *   - ANTHROPIC_API_KEY in .env (project root)
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { spawnSync, execSync } = require("child_process");

const ROOT       = __dirname;
const PROJECT_ROOT = path.join(ROOT, "..", "..");
const CONFIG_FILE  = path.join(ROOT, "config.yaml");

// Load .env from project root
const envFile = path.join(PROJECT_ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const c = {
  reset:   "\x1b[0m", bold:    "\x1b[1m", dim:     "\x1b[2m",
  cyan:    "\x1b[36m", green:  "\x1b[32m", yellow:  "\x1b[33m",
  red:     "\x1b[31m", blue:   "\x1b[34m", magenta: "\x1b[35m",
};

function log(level, msg) {
  const prefix = {
    info:  `${c.cyan}[ios-agent]${c.reset}`,
    ok:    `${c.green}[✓]${c.reset}`,
    warn:  `${c.yellow}[!]${c.reset}`,
    err:   `${c.red}[✗]${c.reset}`,
    step:  `${c.blue}[→]${c.reset}`,
  }[level] || "[?]";
  process.stderr.write(`${prefix} ${msg}\n`);
}

function die(msg) { log("err", msg); process.exit(1); }

function runPython(args, opts = {}) {
  return spawnSync("python", args, {
    cwd:   ROOT,
    stdio: "inherit",
    env:   process.env,
    ...opts,
  });
}

function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdCheck() {
  log("step", "Checking iOS Agent setup...\n");
  let ready = true;

  // Python
  const py = tryRun("python", ["--version"]);
  py.ok ? log("ok", `Python: ${py.out.trim()}`) : (log("err", "Python not found"), ready = false);

  // pymobiledevice3
  const pmd = tryRun("python", ["-c", "import pymobiledevice3; print('ok')"]);
  pmd.out.includes("ok") ? log("ok", "pymobiledevice3 installed") : (log("warn", "pymobiledevice3 missing — run: pip install pymobiledevice3"), ready = false);

  // appium-python-client
  const apc = tryRun("python", ["-c", "import appium; print('ok')"]);
  apc.out.includes("ok") ? log("ok", "appium-python-client installed") : (log("warn", "appium-python-client missing — run: pip install appium-python-client"), ready = false);

  // Appium CLI (check via shell which/where since npm bin may not be in bash PATH)
  let appiumOk = false;
  try {
    const av = require("child_process").execSync("appium --version", { encoding: "utf8", timeout: 5000 }).trim();
    log("ok", `Appium: ${av}`); appiumOk = true;
  } catch (_) {
    try {
      const av2 = require("child_process").execSync("npx appium --version", { encoding: "utf8", timeout: 10000 }).trim();
      log("ok", `Appium (npx): ${av2}`); appiumOk = true;
    } catch (_2) {
      log("warn", "Appium CLI not found — run: npm install -g appium && appium driver install xcuitest");
      ready = false;
    }
  }

  // API Key
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (key && !key.includes("paste")) {
    log("ok", `ANTHROPIC_API_KEY: ${key.slice(0, 12)}...`);
  } else {
    log("warn", "ANTHROPIC_API_KEY not set — add to .env in project root");
    ready = false;
  }

  // Devices
  const devs = tryRun("python", ["-m", "pymobiledevice3", "usbmux", "list"]);
  if (devs.out.trim()) {
    log("ok", "iOS device(s) detected");
    for (const line of devs.out.split("\n").filter(Boolean)) {
      log("info", `  ${line}`);
    }
  } else {
    log("warn", "No iOS devices detected — connect iPhone via USB and trust this computer");
  }

  process.stderr.write("\n");
  if (ready) log("ok", "Ready to run iOS Agent!");
  else       log("warn", "Fix the issues above, then run again");

  process.exit(ready ? 0 : 1);
}

function cmdDevices() {
  log("step", "Scanning for iOS devices...");
  const r = runPython(["-m", "pymobiledevice3", "usbmux", "list"]);
  if (r.status !== 0) die("pymobiledevice3 not installed. Run: pip install pymobiledevice3");
}

function cmdConfig(key, value) {
  if (!fs.existsSync(CONFIG_FILE)) die("config.yaml not found");
  const cfg = fs.readFileSync(CONFIG_FILE, "utf8");

  if (!key) {
    console.log(`\n${c.bold}config.yaml${c.reset}\n`);
    for (const line of cfg.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      console.log(`  ${line}`);
    }
    console.log();
    return;
  }

  const regex = new RegExp(`^(${key}:\\s*).*$`, "m");
  if (!regex.test(cfg)) die(`Key not found: ${key}`);
  const updated = cfg.replace(regex, `$1"${value}"`);
  fs.writeFileSync(CONFIG_FILE, updated, "utf8");
  log("ok", `${key} updated in config.yaml`);
}

function cmdRun(opts) {
  if (!opts.app)  die("--app is required. Example: --app Instagram");
  if (!opts.task) die("--task is required. Example: --task 'follow @someone'");

  process.stderr.write(`
${c.bold}${c.magenta}iOS Agent${c.reset} — Claude-powered iPhone automation
  App:  ${opts.app}
  Task: ${opts.task}

`);

  const args = ["run_agent.py",
    "--app",  opts.app,
    "--task", opts.task,
  ];
  if (opts.bundle) args.push("--bundle", opts.bundle);
  if (opts.udid)   args.push("--udid",   opts.udid);
  if (opts.rounds) args.push("--rounds", opts.rounds);

  const r = runPython(args);
  process.exit(r.status ?? 1);
}

function cmdSetup() {
  process.stderr.write(`
${c.bold}iOS Agent — First-time Setup${c.reset}

${c.bold}${c.yellow}Step 1: Install Apple Mobile Device Support (REQUIRED for Windows)${c.reset}
  iTunes from apple.com provides the USB drivers pymobiledevice3 needs.
  ${c.yellow}Important:${c.reset} Install from apple.com, NOT the Microsoft Store version.
  Download: https://www.apple.com/itunes/download/win64
  After install, plug in your iPhone — Windows should recognize it.

${c.bold}Step 2: Install Appium xcuitest driver${c.reset}
  ${c.cyan}appium driver install xcuitest${c.reset}

${c.bold}Step 3: Connect your iPhone${c.reset}
  - Plug in via USB
  - Tap "Trust This Computer" on your iPhone
  - Enter your passcode if prompted
  - Open iTunes once to confirm the device is recognized

${c.bold}Step 4: Set your API key${c.reset}
  File: ${path.join(PROJECT_ROOT, ".env")}
  Add: ANTHROPIC_API_KEY=sk-ant-your-real-key

${c.bold}Step 5: Start Appium server (keep this terminal open)${c.reset}
  ${c.cyan}appium${c.reset}

${c.bold}Step 6: Run a task (in a new terminal)${c.reset}
  ${c.cyan}node ios-agent-cli.js run --app Safari --task "search for cats"${c.reset}

${c.yellow}Note:${c.reset} Full iOS control (tap/swipe) requires Appium + WebDriverAgent.
WebDriverAgent is built and installed automatically by Appium on first run.
A free Apple Developer account is sufficient.

`);
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === "--app"    && argv[i+1]) opts.app    = argv[++i];
    else if (argv[i] === "--task"   && argv[i+1]) opts.task   = argv[++i];
    else if (argv[i] === "--bundle" && argv[i+1]) opts.bundle = argv[++i];
    else if (argv[i] === "--udid"   && argv[i+1]) opts.udid   = argv[++i];
    else if (argv[i] === "--rounds" && argv[i+1]) opts.rounds = argv[++i];
    else if (argv[i] === "--key"    && argv[i+1]) opts.key    = argv[++i];
    else if (argv[i] === "--value"  && argv[i+1]) opts.value  = argv[++i];
  }
  return opts;
}

function printHelp() {
  console.log([
    "",
    `${c.bold}ios-agent${c.reset} — Claude-powered iPhone automation`,
    "",
    `${c.bold}Commands:${c.reset}`,
    "  setup                            first-time setup guide",
    "  check                            verify all dependencies",
    "  devices                          list connected iPhones",
    "  config                           show config.yaml",
    "  config --key K --value V         update config value",
    "  run --app <App> --task <task>    run a task on your iPhone",
    "",
    `${c.bold}Run options:${c.reset}`,
    "  --bundle <id>    app bundle ID (e.g. com.apple.mobilesafari)",
    "  --udid <id>      device UDID (auto-detected if omitted)",
    "  --rounds <n>     max action rounds (default: 20)",
    "",
    `${c.bold}Examples:${c.reset}`,
    '  node ios-agent-cli.js setup',
    '  node ios-agent-cli.js run --app Safari --task "go to google.com and search cats"',
    '  node ios-agent-cli.js run --app Instagram --task "like the first 3 posts" --rounds 30',
    '  node ios-agent-cli.js run --app Messages --task "send hi to Mom"',
    "",
    `${c.bold}Requires:${c.reset} Appium running (appium), iPhone connected via USB`,
    "",
  ].join("\n"));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd  = argv[0];
const opts = parseArgs(argv.slice(1));

if (!cmd || cmd === "--help" || cmd === "-h") printHelp();
else if (cmd === "setup")   cmdSetup();
else if (cmd === "check")   cmdCheck();
else if (cmd === "devices") cmdDevices();
else if (cmd === "config")  cmdConfig(opts.key, opts.value);
else if (cmd === "run")     cmdRun(opts);
else { log("err", `Unknown command: ${cmd}`); printHelp(); process.exit(1); }
