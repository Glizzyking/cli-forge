#!/usr/bin/env node
/**
 * god — CLI God master orchestrator
 *
 * A conversational AI that dispatches to all sub-agents:
 *   - cli-forge    Build new CLI tools from natural language
 *   - larry        TikTok/carousel content engine
 *   - tools        Browse & install CLI-Anything tools + AppAgent
 *   - appagent     Launch AppAgent learn/run phases
 *   - shell        Run any shell command
 *
 * Usage:
 *   node god.js                  Interactive REPL
 *   node god.js "build me a tool that renames files by date"
 *
 * Requires: ANTHROPIC_API_KEY
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const readline = require("readline");
const { spawnSync, execSync } = require("child_process");

// ─── Load .env from project root ──────────────────────────────────────────────
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY      = process.env.ANTHROPIC_API_KEY;
const API_URL      = "https://api.anthropic.com/v1/messages";
const MODEL        = "claude-sonnet-4-6";
const ROOT         = __dirname;
const HISTORY_DIR  = path.join(os.homedir(), ".cli-god");
const HISTORY_FILE = path.join(HISTORY_DIR, "history.json");
const SESSION_FILE = path.join(HISTORY_DIR, "last-session.json");

// ─── Token tracking ───────────────────────────────────────────────────────────
const tokenLog = { input: 0, output: 0 };
function trackTokens(usage) {
  if (!usage) return;
  tokenLog.input  += usage.input_tokens  || 0;
  tokenLog.output += usage.output_tokens || 0;
}
function printTokenSummary() {
  process.stderr.write(
    `\n${c.dim}[tokens] input: ${tokenLog.input} | output: ${tokenLog.output}${c.reset}\n`
  );
}
const TOOLS_JS = path.join(ROOT, "tools.js");
const FORGE_JS = path.join(ROOT, "cli-forge.js");
const LARRY_JS = path.join(ROOT, "larry-cli", "larry.js");
const APP_DIR  = path.join(ROOT, "tools", "appagent");
const IOS_CLI  = path.join(ROOT, "tools", "ios-agent", "ios-agent-cli.js");

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const c = {
  reset:   "\x1b[0m", bold:    "\x1b[1m", dim:     "\x1b[2m",
  cyan:    "\x1b[36m", green:  "\x1b[32m", yellow:  "\x1b[33m",
  red:     "\x1b[31m", blue:   "\x1b[34m", magenta: "\x1b[35m",
  white:   "\x1b[37m",
};

function log(level, msg) {
  const prefix = {
    info:  `${c.cyan}[god]${c.reset}`,
    ok:    `${c.green}[✓]${c.reset}`,
    warn:  `${c.yellow}[!]${c.reset}`,
    err:   `${c.red}[✗]${c.reset}`,
    tool:  `${c.blue}[→ tool]${c.reset}`,
    ai:    `${c.magenta}[claude]${c.reset}`,
  }[level] || "[?]";
  process.stderr.write(`${prefix} ${msg}\n`);
}

function die(msg) { log("err", msg); process.exit(1); }

function banner() {
  process.stderr.write(`
${c.bold}${c.cyan}╔══════════════════════════════════════════╗
║          CLI GOD  —  Master Agent        ║
║  forge · larry · cli-anything · appagent ║
╚══════════════════════════════════════════╝${c.reset}

Type anything to get started. Type ${c.bold}exit${c.reset} to quit.

`);
}

// ─── Sub-agent runner ─────────────────────────────────────────────────────────

function runNode(scriptPath, args, cwd) {
  log("tool", `node ${path.basename(scriptPath)} ${args.join(" ")}`);
  const r = spawnSync("node", [scriptPath, ...args], {
    cwd:      cwd || ROOT,
    encoding: "utf8",
    env:      process.env,
    timeout:  120_000,
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    status: r.status ?? -1,
  };
}

function runPython(args, cwd) {
  log("tool", `python ${args.join(" ")}`);
  const r = spawnSync("python", args, {
    cwd:      cwd,
    encoding: "utf8",
    env:      process.env,
    timeout:  300_000,
    stdio:    ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    status: r.status ?? -1,
  };
}

function runShell(command) {
  log("tool", `shell: ${command}`);
  try {
    const out = execSync(command, { encoding: "utf8", timeout: 60_000, env: process.env });
    return { stdout: out, stderr: "", status: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || e.message, status: e.status || 1 };
  }
}

function truncate(s, max = 3000) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`;
}

function formatResult(r) {
  const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
  return `exit_code: ${r.status}\n${out || "(no output)"}`;
}

// ─── Tool definitions (Claude tool_use spec) ──────────────────────────────────

const TOOL_DEFS = [
  {
    name: "forge",
    description: "Build a brand-new CLI tool from a natural language description using cli-forge. The tool will be planned, coded, tested, and installed automatically.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What the new CLI tool should do" },
        output_dir:  { type: "string", description: "Where to install it (default: current dir)" },
        name:        { type: "string", description: "Override the tool name" },
        fast:        { type: "boolean", description: "Use haiku model (faster/cheaper)" },
        smart:       { type: "boolean", description: "Use more fix cycles (more thorough)" },
      },
      required: ["description"],
    },
  },
  {
    name: "forge_enhance",
    description: "Enhance or modify an existing CLI tool file using cli-forge's enhance mode.",
    input_schema: {
      type: "object",
      properties: {
        file:    { type: "string", description: "Path to the existing CLI JS file" },
        request: { type: "string", description: "What changes to make" },
      },
      required: ["file", "request"],
    },
  },
  {
    name: "larry",
    description: "Run any larry command for TikTok/carousel content. Commands: init, auth, add <url>, list, create, schedule, test.",
    input_schema: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to larry (e.g. ['add', 'https://tiktok.com/...'] or ['list'])",
        },
      },
      required: ["args"],
    },
  },
  {
    name: "list_tools",
    description: "List all available tools from CLI-Anything and AppAgent. Optionally filter by source or category.",
    input_schema: {
      type: "object",
      properties: {
        source:   { type: "string", description: "Filter by source: 'cli-anything' or 'appagent'" },
        category: { type: "string", description: "Filter by category (e.g. 'ai', 'image', 'video')" },
      },
    },
  },
  {
    name: "tool_info",
    description: "Get full details about a specific tool by name (e.g. 'blender', 'ollama', 'appagent').",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name" },
      },
      required: ["name"],
    },
  },
  {
    name: "install_tool",
    description: "Get and run the install command for a CLI-Anything tool. Prints the pip install command.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name from CLI-Anything registry" },
        run_install: { type: "boolean", description: "If true, actually execute the pip install command (requires pip)" },
      },
      required: ["name"],
    },
  },
  {
    name: "ios_agent",
    description: "Control an iPhone with Claude Vision AI. Runs tasks autonomously on any iOS app. Requires iPhone connected via USB and Appium running.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["run", "check", "devices", "setup"],
          description: "'run' to execute a task, 'check' to verify setup, 'devices' to list phones, 'setup' for first-time guide",
        },
        app:    { type: "string", description: "App name (e.g. Instagram, Safari, Messages)" },
        task:   { type: "string", description: "What to do on the app in plain English" },
        bundle: { type: "string", description: "Optional: app bundle ID (e.g. com.apple.mobilesafari)" },
        rounds: { type: "number", description: "Max action rounds (default 20)" },
      },
      required: ["command"],
    },
  },
  {
    name: "appagent",
    description: "Launch AppAgent — the multimodal LLM agent for operating Android smartphone apps. Requires Android device/emulator + ADB connected.",
    input_schema: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: ["learn", "run"],
          description: "'learn' to explore and build knowledge, 'run' to execute tasks autonomously",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Additional arguments to pass to the script",
        },
      },
      required: ["phase"],
    },
  },
  {
    name: "shell",
    description: "Run an arbitrary shell command on the local machine. Use for file operations, git, npm, pip, etc.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
];

// ─── Tool dispatch ─────────────────────────────────────────────────────────────

function dispatchTool(name, input) {
  switch (name) {

    case "ios_agent": {
      const iosArgs = [input.command];
      if (input.app)    iosArgs.push("--app",    input.app);
      if (input.task)   iosArgs.push("--task",   input.task);
      if (input.bundle) iosArgs.push("--bundle", input.bundle);
      if (input.rounds) iosArgs.push("--rounds", String(input.rounds));
      const r = runNode(IOS_CLI, iosArgs, path.join(ROOT, "tools", "ios-agent"));
      return truncate(formatResult(r));
    }

    case "forge": {
      const args = [input.description];
      if (input.output_dir) args.push("--output", input.output_dir);
      if (input.name)       args.push("--name",   input.name);
      if (input.fast)       args.push("--fast");
      if (input.smart)      args.push("--smart");
      const r = runNode(FORGE_JS, args);
      return truncate(formatResult(r));
    }

    case "forge_enhance": {
      const filePath = path.resolve(input.file);
      const r = runNode(FORGE_JS, ["--enhance", filePath, input.request]);
      return truncate(formatResult(r));
    }

    case "larry": {
      const r = runNode(LARRY_JS, input.args || [], path.join(ROOT, "larry-cli"));
      return truncate(formatResult(r));
    }

    case "list_tools": {
      const args = ["list"];
      if (input.source)   args.push("--source",   input.source);
      if (input.category) args.push("--category",  input.category);
      const r = runNode(TOOLS_JS, args);
      return truncate(formatResult(r));
    }

    case "tool_info": {
      const r = runNode(TOOLS_JS, ["info", input.name]);
      return truncate(formatResult(r));
    }

    case "install_tool": {
      const info = runNode(TOOLS_JS, ["info", input.name]);
      if (input.run_install) {
        // Extract install_cmd from info output and run it
        const match = (info.stdout + info.stderr).match(/pip install [^\n]+/);
        if (match) {
          const installResult = runShell(match[0]);
          return truncate(`Info:\n${formatResult(info)}\n\nInstall:\n${formatResult(installResult)}`);
        }
        return truncate(`Could not extract install command from:\n${formatResult(info)}`);
      }
      return truncate(formatResult(info));
    }

    case "appagent": {
      const script = input.phase === "learn" ? "learn.py" : "run.py";
      const args   = [script, ...(input.args || [])];
      const r = runPython(args, APP_DIR);
      return truncate(formatResult(r));
    }

    case "shell": {
      const r = runShell(input.command);
      return truncate(formatResult(r));
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Claude API ───────────────────────────────────────────────────────────────

const SYSTEM = `You are CLI God, a master orchestrator that controls a suite of powerful CLI sub-agents.

You have access to these sub-agents via tools:
- **forge**: Build new CLI tools from natural language (uses claude-sonnet-4-6, plan→build→test→install)
- **forge_enhance**: Patch/extend existing CLI tool files
- **larry**: TikTok-to-carousel content engine (init, auth, add URL, list, create, schedule, test)
- **list_tools**: Browse 17+ tools from CLI-Anything (Blender, GIMP, OBS, LibreOffice, Ollama, Zoom, etc.) + AppAgent
- **tool_info**: Get full details/install instructions for any registered tool
- **install_tool**: Install any CLI-Anything tool via pip
- **ios_agent**: Control an iPhone with Claude Vision — run tasks on any iOS app (Instagram, Safari, Messages, etc.) via natural language. Requires Appium + USB connection.
- **appagent**: Launch AppAgent to operate Android smartphone apps via LLM-driven GUI automation (ADB)
- **shell**: Run any shell command for file ops, git, npm, pip, etc.

Personality: concise, direct, powerful. You are the god of CLIs. When asked to do something:
1. Pick the right sub-agent(s) and call them
2. Interpret the output and report results clearly
3. Chain multiple tools if needed (e.g. list → info → install)

Always prefer calling tools over just describing what to do.`;

async function* streamClaude(messages) {
  const body = {
    model:      MODEL,
    max_tokens: 8192,
    system:     SYSTEM,
    tools:      TOOL_DEFS,
    messages,
    stream:     true,
  };

  const res = await fetch(API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  // Accumulate the full response from the stream
  let fullText     = "";
  let toolUses     = [];
  let currentTool  = null;
  let currentInput = "";
  let stopReason   = null;

  for await (const chunk of res.body) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      let evt;
      try { evt = JSON.parse(data); } catch { continue; }

      if (evt.type === "content_block_start") {
        if (evt.content_block.type === "tool_use") {
          currentTool  = { id: evt.content_block.id, name: evt.content_block.name };
          currentInput = "";
        } else if (evt.content_block.type === "text") {
          // text block starting
        }
      } else if (evt.type === "content_block_delta") {
        if (evt.delta.type === "text_delta") {
          const t = evt.delta.text;
          fullText += t;
          process.stdout.write(t);  // stream text to terminal
        } else if (evt.delta.type === "input_json_delta") {
          currentInput += evt.delta.partial_json;
        }
      } else if (evt.type === "content_block_stop") {
        if (currentTool) {
          let parsed;
          try { parsed = JSON.parse(currentInput); } catch { parsed = {}; }
          toolUses.push({ ...currentTool, input: parsed });
          currentTool  = null;
          currentInput = "";
        }
      } else if (evt.type === "message_delta") {
        stopReason = evt.delta.stop_reason;
      } else if (evt.type === "message_start") {
        trackTokens(evt.message?.usage);
      } else if (evt.type === "message_delta") {
        trackTokens(evt.usage);
      }
    }
  }

  if (fullText) process.stdout.write("\n");

  yield { text: fullText, toolUses, stopReason };
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

async function runTurn(messages) {
  // Keep looping while Claude wants to use tools
  while (true) {
    let result;
    for await (result of streamClaude(messages)) { /* last value */ }

    const { text, toolUses, stopReason } = result;

    // Add assistant message to history
    const assistantContent = [];
    if (text) assistantContent.push({ type: "text", text });
    for (const tu of toolUses) {
      assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    if (assistantContent.length) {
      messages.push({ role: "assistant", content: assistantContent });
    }

    // If no tool calls, we're done
    if (!toolUses.length || stopReason === "end_turn") break;

    // Dispatch all tool calls
    const toolResults = [];
    for (const tu of toolUses) {
      process.stderr.write(`\n${c.blue}[→]${c.reset} ${c.bold}${tu.name}${c.reset} ${c.dim}${JSON.stringify(tu.input)}${c.reset}\n`);
      let output;
      try {
        output = dispatchTool(tu.name, tu.input);
      } catch (e) {
        output = `Error: ${e.message}`;
      }
      process.stderr.write(`${c.dim}${output.slice(0, 200)}${output.length > 200 ? "…" : ""}${c.reset}\n`);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

// ─── History persistence ───────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
        const age = Date.now() - (saved.ts || 0);
        if (age < 4 * 60 * 60 * 1000) { // resume if < 4 hours old
          log("info", `Resuming session (${saved.messages.length} messages) — type 'new' to start fresh`);
          return saved.messages;
        }
      }
    }
  } catch (_) {}
  return [];
}

function saveHistory(messages) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ts: Date.now(), messages }, null, 2));
  } catch (_) {}
}

function appendToLog(role, content) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), role, content }) + "\n";
    fs.appendFileSync(HISTORY_FILE, entry);
  } catch (_) {}
}

async function repl() {
  if (!API_KEY) die("ANTHROPIC_API_KEY is not set.");
  banner();

  let messages = loadHistory();

  // Ctrl+C — clean exit with token summary
  process.on("SIGINT", () => {
    saveHistory(messages);
    printTokenSummary();
    process.stderr.write("\n");
    process.exit(0);
  });

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stderr,
    prompt: `\n${c.bold}${c.cyan}you${c.reset} › `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === "exit" || input === "quit") {
      saveHistory(messages);
      printTokenSummary();
      process.exit(0);
    }

    if (input === "new" || input === "reset") {
      messages = [];
      log("info", "Started new session.");
      rl.prompt();
      return;
    }

    if (input === "tokens") {
      printTokenSummary();
      rl.prompt();
      return;
    }

    messages.push({ role: "user", content: input });
    appendToLog("user", input);

    process.stderr.write(`\n${c.magenta}god${c.reset} › `);

    try {
      await runTurn(messages);
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "assistant") {
        const text = Array.isArray(lastMsg.content)
          ? lastMsg.content.filter(b => b.type === "text").map(b => b.text).join("")
          : lastMsg.content;
        if (text) appendToLog("assistant", text);
      }
      saveHistory(messages);
    } catch (e) {
      log("err", e.message);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    saveHistory(messages);
    printTokenSummary();
    process.exit(0);
  });
}

// ─── One-shot mode ─────────────────────────────────────────────────────────────

async function oneShot(query) {
  if (!API_KEY) die("ANTHROPIC_API_KEY is not set.");
  const messages = [{ role: "user", content: query }];
  process.stderr.write(`\n${c.magenta}god${c.reset} › `);
  try {
    await runTurn(messages);
  } catch (e) {
    die(e.message);
  }
  process.stdout.write("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.length === 0) {
  repl().catch(e => die(e.message));
} else if (argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write([
    "",
    `${c.bold}god${c.reset} — CLI God master orchestrator`,
    "",
    `${c.bold}Usage:${c.reset}`,
    "  node god.js                    Interactive REPL",
    '  node god.js "do something"     One-shot query',
    "",
    `${c.bold}Sub-agents available:${c.reset}`,
    "  forge        Build new CLI tools from natural language",
    "  forge_enhance  Patch existing CLI tools",
    "  larry        TikTok/carousel content engine",
    "  list_tools   Browse CLI-Anything (17 tools) + AppAgent",
    "  tool_info    Get details on any tool",
    "  install_tool Install any CLI-Anything tool via pip",
    "  appagent     Smartphone GUI automation agent",
    "  shell        Run any shell command",
    "",
    `${c.bold}Requires:${c.reset} ANTHROPIC_API_KEY`,
    "",
  ].join("\n"));
} else {
  oneShot(argv.join(" ")).catch(e => die(e.message));
}
