#!/usr/bin/env node

/**
 * cli-forge — AI-powered master CLI builder
 *
 * Usage:
 *   node cli-forge.js "a tool that does X" --output ~/bin
 *   node cli-forge.js "a tool that does X" --output ~/bin --name mytool
 *   node cli-forge.js --enhance larry.js "add an export command"
 *   node cli-forge.js "..." --fast          (haiku everywhere, cheapest)
 *   node cli-forge.js "..." --smart         (sonnet everywhere + more cycles)
 *
 * Requires: ANTHROPIC_API_KEY env variable
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { spawnSync, execSync } = require("child_process");

// ─── Load .env from project root ──────────────────────────────────────────────
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ─── Models ───────────────────────────────────────────────────────────────────
// Haiku = cheap JSON + planning. Sonnet = code generation + fixing.

const MODELS = {
  plan:  "claude-haiku-4-5-20251001",   // fast/cheap — just emits JSON
  build: "claude-sonnet-4-6",           // writes production code
  fix:   "claude-sonnet-4-6",           // needs reasoning to fix bugs
};

const MAX_TOKENS_PLAN  = 4096;
const MAX_TOKENS_CODE  = 16384;   // large CLIs need room
const MAX_CYCLES       = 5;
const API_KEY          = process.env.ANTHROPIC_API_KEY;
const API_URL          = "https://api.anthropic.com/v1/messages";

// ─── Token tracking ───────────────────────────────────────────────────────────

const tokenLog = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function trackUsage(usage) {
  if (!usage) return;
  tokenLog.input      += usage.input_tokens       || 0;
  tokenLog.output     += usage.output_tokens      || 0;
  tokenLog.cacheWrite += usage.cache_creation_input_tokens || 0;
  tokenLog.cacheRead  += usage.cache_read_input_tokens     || 0;
}

function printTokenSummary() {
  const saved = tokenLog.cacheRead;
  const total = tokenLog.input + tokenLog.output;
  process.stderr.write(
    `\n${c.dim}[tokens] input: ${tokenLog.input} | output: ${tokenLog.output}` +
    ` | cache_write: ${tokenLog.cacheWrite} | cache_read: ${saved}` +
    ` | saved ~${saved} tokens via cache${c.reset}\n`
  );
}

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const c = {
  reset:   "\x1b[0m", bold:    "\x1b[1m", dim:     "\x1b[2m",
  cyan:    "\x1b[36m", green:  "\x1b[32m", yellow:  "\x1b[33m",
  red:     "\x1b[31m", blue:   "\x1b[34m", magenta: "\x1b[35m",
};

function log(level, msg) {
  const prefix = {
    info:    `${c.cyan}[forge]${c.reset}`,
    success: `${c.green}[✓]${c.reset}`,
    warn:    `${c.yellow}[!]${c.reset}`,
    error:   `${c.red}[✗]${c.reset}`,
    step:    `${c.blue}[→]${c.reset}`,
    ai:      `${c.magenta}[claude]${c.reset}`,
  }[level] || "[?]";
  process.stderr.write(`${prefix} ${msg}\n`);
}

function die(msg) { log("error", msg); process.exit(1); }

function banner(title) {
  const line = "─".repeat(60);
  process.stderr.write(`\n${c.bold}${c.cyan}${line}\n  ${title}\n${line}${c.reset}\n\n`);
}

// ─── Args parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    description: "",
    output:  process.cwd(),
    name:    null,
    enhance: null,   // path to existing CLI file to patch
    fast:    false,  // haiku everywhere
    smart:   false,  // more cycles, bigger context
  };

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === "--output"  || argv[i] === "-o")  { args.output  = argv[++i]; }
    else if (argv[i] === "--name"    || argv[i] === "-n")  { args.name    = argv[++i]; }
    else if (argv[i] === "--enhance" || argv[i] === "-e")  { args.enhance = argv[++i]; }
    else if (argv[i] === "--fast")                          { args.fast    = true; }
    else if (argv[i] === "--smart")                         { args.smart   = true; }
    else rest.push(argv[i]);
  }
  args.description = rest.join(" ").trim();
  return args;
}

// ─── Claude API (with prompt caching) ────────────────────────────────────────
//
// System prompts are sent as arrays with cache_control so the API can
// reuse the KV cache across calls — repeated fix cycles only pay for
// the NEW user message, not the full system prompt again.

async function callClaude({ model, maxTokens, systemText, userText, label = "" }) {
  if (!API_KEY) die("ANTHROPIC_API_KEY is not set.");
  if (label) log("ai", `${label} ...`);

  const body = {
    model,
    max_tokens: maxTokens,
    // Cache the system prompt — subsequent calls in the same forge run
    // read from cache instead of paying full input token cost.
    system: [
      {
        type: "text",
        text: systemText,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userText }],
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta":    "prompt-caching-2024-07-31",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    die(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  trackUsage(data.usage);

  return data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .replace(/^```(?:json|javascript|js|bash)?\n?/gim, "")
    .replace(/\n?```\s*$/gim, "")
    .trim();
}

// ─── Step 1: Plan ─────────────────────────────────────────────────────────────
// Uses haiku — cheaper model is fine for JSON schema generation.

const PLAN_SYSTEM = `You are a senior CLI architect. Output ONLY valid JSON — no markdown, no explanation.

Schema:
{
  "name": "slug-name",
  "description": "one line",
  "commands": [
    {
      "name": "command-name or 'default'",
      "description": "what it does",
      "flags": [{ "flag": "--name", "alias": "-n", "type": "string|boolean|number", "required": true, "default": null, "description": "..." }],
      "positionalArgs": [{ "name": "input", "required": true, "description": "..." }]
    }
  ],
  "edgeCases": ["..."],
  "errorStates": ["..."],
  "dependencies": ["only node built-ins"],
  "testCases": [
    {
      "id": "test_001",
      "description": "...",
      "command": "node TOOL_FILE <args>",
      "expectExitCode": 0,
      "expectOutputContains": ["..."],
      "expectOutputNotContains": ["..."],
      "setupSteps": [],
      "teardownSteps": []
    }
  ]
}`;

async function planTool(description, model) {
  banner("STEP 1 — Planning");
  const raw = await callClaude({
    model,
    maxTokens: MAX_TOKENS_PLAN,
    systemText: PLAN_SYSTEM,
    userText:   `Plan this CLI tool: ${description}`,
    label:      "Planning (haiku)",
  });

  try {
    const plan = JSON.parse(raw);
    log("success", `Plan: ${plan.commands.length} command(s), ${plan.testCases.length} test(s), ${plan.edgeCases.length} edge cases`);
    return plan;
  } catch (e) {
    die(`Failed to parse plan JSON: ${e.message}\n\nRaw:\n${raw}`);
  }
}

// ─── Step 2: Build ────────────────────────────────────────────────────────────

const BUILD_SYSTEM = `You are an expert Node.js CLI developer. Output ONLY raw, runnable Node.js code — no markdown fences, no explanation.

Rules:
- Use ONLY Node.js built-in modules (fs, path, os, child_process, readline, https, url, etc.)
- NO npm dependencies
- Start with: #!/usr/bin/env node
- Implement every command, flag, edge case, and error state from the plan
- Use process.argv for argument parsing (no commander, no yargs)
- process.exit(0) on success, process.exit(1) on error
- Write helpful error messages to stderr, results to stdout
- Handle --help on every command
- Validate all inputs, handle missing files, bad flags, etc.`;

async function buildTool(plan, model, previousCode = null, failingSummary = null) {
  banner(previousCode ? "FIXING — Iterating on failures" : "STEP 2 — Building CLI");

  // On fix cycles: strip testCases from plan (already in context) to save tokens.
  // Only send the parts of the plan relevant to fixing.
  let planPayload;
  if (previousCode && failingSummary) {
    const { testCases: _dropped, ...planCore } = plan;
    planPayload = JSON.stringify(planCore);
  } else {
    planPayload = JSON.stringify(plan, null, 2);
  }

  let userText;
  if (previousCode && failingSummary) {
    userText = [
      `Plan (testCases omitted to save tokens):\n${planPayload}`,
      `\nCurrent code with failures:\n${previousCode}`,
      `\nFailing tests:\n${failingSummary}`,
      `\nFix ALL failures. Return the complete corrected script.`,
    ].join("\n");
  } else {
    userText = `Build the complete CLI from this plan:\n${planPayload}`;
  }

  const code = await callClaude({
    model,
    maxTokens:  MAX_TOKENS_CODE,
    systemText: BUILD_SYSTEM,
    userText,
    label: previousCode ? "Fixing failures" : "Generating CLI code",
  });

  log("success", `Code: ${code.split("\n").length} lines`);
  return code;
}

// ─── Step 2b: Enhance (patch existing CLI) ────────────────────────────────────

const ENHANCE_SYSTEM = `You are an expert Node.js CLI developer. You will receive an existing CLI script and a change request.
Output ONLY the complete updated script — no markdown fences, no explanation, no diff format.
Preserve all existing functionality. Only add or modify what is requested.
Keep the same code style as the original.`;

async function enhanceTool(filePath, request, model) {
  banner("ENHANCE — Patching Existing CLI");

  const existing = fs.readFileSync(filePath, "utf8");
  log("info", `Loaded: ${filePath} (${existing.split("\n").length} lines)`);

  const code = await callClaude({
    model,
    maxTokens:  MAX_TOKENS_CODE,
    systemText: ENHANCE_SYSTEM,
    userText:   `Existing CLI:\n${existing}\n\nChange request: ${request}`,
    label:      "Enhancing CLI",
  });

  log("success", `Enhanced code: ${code.split("\n").length} lines`);
  return code;
}

// ─── Step 3: Syntax check ─────────────────────────────────────────────────────
// Catch obvious syntax errors before wasting test cycles.

function syntaxCheck(toolFile) {
  const r = spawnSync("node", ["--check", toolFile], { encoding: "utf8" });
  if (r.status !== 0) {
    log("warn", `Syntax error detected:\n${r.stderr}`);
    return r.stderr || "Syntax error";
  }
  return null;
}

// ─── Step 4: Test ─────────────────────────────────────────────────────────────

function runTests(plan, toolFile) {
  banner("STEP 3 — Running Test Suite");

  const results = { passed: 0, failed: 0, failures: [] };

  for (const tc of plan.testCases) {
    log("step", `Test ${tc.id}: ${tc.description}`);

    for (const cmd of (tc.setupSteps || [])) {
      try { execSync(cmd, { stdio: "pipe" }); } catch (_) {}
    }

    const rawCmd = tc.command.replace(/TOOL_FILE/g, toolFile);
    const parts  = rawCmd.split(/\s+/);
    const result = spawnSync(parts[0], parts.slice(1), {
      encoding: "utf8", timeout: 15000, env: { ...process.env },
    });

    const combined = ((result.stdout || "") + "\n" + (result.stderr || "")).trim();
    const exitCode = result.status ?? -1;
    let passed = true;
    const reasons = [];

    if (exitCode !== tc.expectExitCode) {
      passed = false;
      reasons.push(`Exit code: expected ${tc.expectExitCode}, got ${exitCode}`);
    }
    for (const s of (tc.expectOutputContains    || [])) {
      if (!combined.includes(s)) { passed = false; reasons.push(`Missing: "${s}"`); }
    }
    for (const s of (tc.expectOutputNotContains || [])) {
      if (combined.includes(s))  { passed = false; reasons.push(`Found forbidden: "${s}"`); }
    }

    for (const cmd of (tc.teardownSteps || [])) {
      try { execSync(cmd, { stdio: "pipe" }); } catch (_) {}
    }

    if (passed) {
      log("success", "  PASSED");
      results.passed++;
    } else {
      log("error", `  FAILED: ${reasons.join("; ")}`);
      results.failed++;
      results.failures.push({
        id: tc.id, description: tc.description, command: rawCmd, reasons,
        // Only send first 300 chars of output — keeps fix prompts lean
        stdout: (result.stdout || "").slice(0, 300),
        stderr: (result.stderr || "").slice(0, 300),
      });
    }
  }

  process.stderr.write(
    `\n${c.bold}Results: ${c.green}${results.passed} passed${c.reset}, ` +
    `${results.failed > 0 ? c.red : c.green}${results.failed} failed${c.reset}\n\n`
  );
  return results;
}

// ─── Step 5: Install ──────────────────────────────────────────────────────────

function installTool(code, nameOrPlan, outputDir, customName) {
  banner("STEP 4 — Installing");

  const name     = customName || (typeof nameOrPlan === "string" ? nameOrPlan : nameOrPlan.name);
  const expanded = outputDir.replace(/^~/, os.homedir());
  fs.mkdirSync(expanded, { recursive: true });

  const dest = path.join(expanded, `${name}.js`);
  fs.writeFileSync(dest, code, "utf8");
  try { fs.chmodSync(dest, 0o755); } catch (_) {}

  log("success", `Installed: ${dest}`);

  const shimPath = path.join(expanded, name);
  fs.writeFileSync(shimPath, `#!/bin/sh\nexec node "${dest}" "$@"\n`, "utf8");
  try { fs.chmodSync(shimPath, 0o755); } catch (_) {}
  log("success", `Shell shim: ${shimPath}`);
  log("info",    `Add ${expanded} to PATH to use: ${name} <args>`);

  return dest;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args    = parseArgs(process.argv.slice(2));
  const maxCycles = args.smart ? 8 : MAX_CYCLES;

  // Model selection
  const planModel  = args.fast ? "claude-haiku-4-5-20251001" : MODELS.plan;
  const buildModel = args.fast ? "claude-haiku-4-5-20251001" : (args.smart ? "claude-sonnet-4-6" : MODELS.build);

  // ── --enhance mode: patch an existing CLI ──────────────────────────────────
  if (args.enhance) {
    if (!fs.existsSync(args.enhance)) die(`File not found: ${args.enhance}`);
    if (!args.description) die("Usage: cli-forge --enhance <file> \"<change request>\"");

    banner("CLI FORGE — Enhance Mode");
    log("info", `File:    ${args.enhance}`);
    log("info", `Request: ${args.description}`);

    const code        = await enhanceTool(args.enhance, args.description, buildModel);
    const syntaxErr   = syntaxCheck;
    const tmpFile     = args.enhance + ".forge-tmp.js";
    fs.writeFileSync(tmpFile, code, "utf8");
    const err = syntaxCheck(tmpFile);
    fs.unlinkSync(tmpFile);

    if (err) {
      log("error", "Enhanced code has syntax errors — aborting. Original file unchanged.");
      die(err);
    }

    fs.writeFileSync(args.enhance, code, "utf8");
    log("success", `Patched in-place: ${args.enhance}`);
    printTokenSummary();
    return;
  }

  // ── Build mode ─────────────────────────────────────────────────────────────
  if (!args.description) {
    process.stderr.write([
      `${c.bold}cli-forge${c.reset} — AI-powered CLI builder`,
      "",
      `${c.bold}Usage:${c.reset}`,
      `  node cli-forge.js "<description>" [options]`,
      `  node cli-forge.js --enhance <file> "<change request>"`,
      "",
      `${c.bold}Options:${c.reset}`,
      `  --output, -o <dir>   Install destination (default: cwd)`,
      `  --name,   -n <name>  Override CLI name`,
      `  --enhance, -e <file> Patch an existing CLI file instead of building fresh`,
      `  --fast               Use haiku for everything (cheapest, fewer tokens)`,
      `  --smart              More fix cycles + bigger context window`,
      "",
      `${c.bold}Examples:${c.reset}`,
      `  node cli-forge.js "a tool that bulk-renames files by pattern" --output ~/bin`,
      `  node cli-forge.js "a markdown to HTML converter" -o ~/bin -n md2html --fast`,
      `  node cli-forge.js --enhance larry.js "add an export command that writes CSV"`,
      "",
      `${c.bold}Requires:${c.reset} ANTHROPIC_API_KEY`,
      "",
    ].join("\n"));
    process.exit(0);
  }

  banner("CLI FORGE — AI-Powered CLI Builder");
  log("info", `Building: "${args.description}"`);
  log("info", `Output:   ${args.output}`);
  log("info", `Mode:     ${args.fast ? "fast (haiku)" : args.smart ? "smart (sonnet, more cycles)" : "default"}`);
  if (args.name) log("info", `Name:     ${args.name}`);

  // Phase 1: Plan (haiku)
  const plan     = await planTool(args.description, planModel);
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), "cli-forge-"));
  const planFile = path.join(tmpDir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

  // Phase 2+3: Build → syntax check → test → fix loop
  let code        = null;
  let testResults = null;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    // Build or fix
    const failingSummary = testResults
      ? testResults.failures.map(f =>
          `Test ${f.id} (${f.description}):\n  ${f.reasons.join("; ")}\n  stdout: ${f.stdout}\n  stderr: ${f.stderr}`
        ).join("\n\n")
      : null;

    code = await buildTool(plan, buildModel, code, failingSummary);

    // Write temp file
    const toolFile = path.join(tmpDir, `${plan.name}.js`);
    fs.writeFileSync(toolFile, code, "utf8");
    try { fs.chmodSync(toolFile, 0o755); } catch (_) {}

    // Syntax check before wasting a test cycle
    const syntaxErr = syntaxCheck(toolFile);
    if (syntaxErr) {
      log("warn", `Cycle ${cycle}: syntax error — will fix next cycle`);
      testResults = {
        failed: 1, passed: 0,
        failures: [{ id: "syntax", description: "Syntax check", command: "", reasons: [syntaxErr], stdout: "", stderr: syntaxErr }],
      };
      continue;
    }

    if (plan.testCases.length === 0) {
      log("warn", "No test cases — skipping tests.");
      break;
    }

    testResults = runTests(plan, toolFile);
    if (testResults.failed === 0) {
      log("success", `All tests passed on cycle ${cycle}!`);
      break;
    }

    if (cycle < maxCycles) {
      log("warn", `Cycle ${cycle}/${maxCycles} — ${testResults.failed} failure(s). Fixing...`);
    } else {
      log("error", `Max cycles reached. Installing best version (${testResults.failed} test(s) still failing).`);
    }
  }

  // Phase 4: Install
  const installedPath = installTool(code, plan, args.output, args.name);

  banner("DONE");
  log("success", `"${args.name || plan.name}" ready at: ${installedPath}`);
  if (testResults) log("info", `Tests: ${testResults.passed} passed, ${testResults.failed} failed`);
  log("info", `Plan: ${planFile}`);

  printTokenSummary();
  process.exit(testResults && testResults.failed > 0 ? 1 : 0);
}

main().catch(e => die(e.message));
