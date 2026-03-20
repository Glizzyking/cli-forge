#!/usr/bin/env node

/**
 * cli-forge — AI-powered master CLI builder
 *
 * Usage:
 *   node cli-forge.js "a tool that does X" --output /usr/local/bin
 *   node cli-forge.js "a tool that does X" --output ~/my-tools --name mytool
 *
 * Requires: ANTHROPIC_API_KEY env variable
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { spawnSync, execSync } = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────────────

const MODEL        = "claude-sonnet-4-6";
const MAX_TOKENS   = 8192;
const MAX_CYCLES   = 5;
const API_KEY      = process.env.ANTHROPIC_API_KEY;
const API_URL      = "https://api.anthropic.com/v1/messages";

// ─── ANSI colours ────────────────────────────────────────────────────────────

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
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
  const args = { description: "", output: process.cwd(), name: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output" || argv[i] === "-o") { args.output = argv[++i]; }
    else if (argv[i] === "--name"   || argv[i] === "-n") { args.name = argv[++i]; }
    else rest.push(argv[i]);
  }
  args.description = rest.join(" ").trim();
  return args;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function claude(systemPrompt, userPrompt, label = "") {
  if (!API_KEY) die("ANTHROPIC_API_KEY is not set.");
  if (label) log("ai", `${label} ...`);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    die(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .replace(/^```(?:json|javascript|js|bash)?\n?/gim, "")
    .replace(/\n?```\s*$/gim, "")
    .trim();
}

// ─── Step 1: Plan ─────────────────────────────────────────────────────────────

async function planTool(description) {
  banner("STEP 1 — Deep Planning");

  const system = `You are a senior CLI architect. Your job is to create an exhaustive, production-grade plan for a CLI tool.
Output ONLY valid JSON — no markdown, no explanation. The JSON must match this exact schema:

{
  "name": "slug-name-for-the-cli",
  "description": "one line description",
  "language": "node",
  "commands": [
    {
      "name": "command-name or 'default' for the root command",
      "description": "what it does",
      "flags": [
        { "flag": "--name", "alias": "-n", "type": "string|boolean|number", "required": true, "default": null, "description": "..." }
      ],
      "positionalArgs": [
        { "name": "input", "required": true, "description": "..." }
      ]
    }
  ],
  "edgeCases": ["list of edge cases to handle"],
  "errorStates": ["list of error states and how to handle them"],
  "dependencies": ["only node built-ins allowed — list which ones"],
  "testCases": [
    {
      "id": "test_001",
      "description": "what this tests",
      "command": "node TOOL_FILE <args>",
      "expectExitCode": 0,
      "expectOutputContains": ["string that must appear in stdout"],
      "expectOutputNotContains": ["string that must NOT appear"],
      "setupSteps": ["shell commands to run before this test"],
      "teardownSteps": ["shell commands to run after this test"]
    }
  ]
}`;

  const raw = await claude(system,
    `Create an exhaustive plan for this CLI tool: ${description}`,
    "Planning exhaustively"
  );

  try {
    const plan = JSON.parse(raw);
    log("success", `Plan complete: ${plan.commands.length} command(s), ${plan.testCases.length} test case(s)`);
    log("info", `Edge cases: ${plan.edgeCases.length} | Error states: ${plan.errorStates.length}`);
    return plan;
  } catch (e) {
    die(`Failed to parse plan JSON: ${e.message}\n\nRaw output:\n${raw}`);
  }
}

// ─── Step 2: Build ────────────────────────────────────────────────────────────

async function buildTool(plan, previousCode = null, testFailures = null) {
  banner(previousCode ? "FIXING — Iterating on failures" : "STEP 2 — Building CLI");

  const system = `You are an expert Node.js CLI developer. Output ONLY raw, runnable Node.js code — no markdown fences, no explanation, no preamble.

Rules:
- Use ONLY Node.js built-in modules (fs, path, os, child_process, readline, https, url, etc.)
- NO npm dependencies
- The script must start with: #!/usr/bin/env node
- Implement every command, flag, edge case, and error state from the plan
- Use process.argv for argument parsing (no commander, no yargs)
- Use process.exit(0) on success, process.exit(1) on error
- Write clear, helpful error messages to stderr
- Write results/output to stdout
- Handle --help on every command
- Be robust: validate all inputs, handle missing files, bad flags, etc.`;

  let userPrompt;
  if (previousCode && testFailures) {
    userPrompt = `Here is the plan:\n${JSON.stringify(plan, null, 2)}\n\nHere is the current code that FAILED tests:\n\`\`\`\n${previousCode}\n\`\`\`\n\nFailing tests:\n${testFailures}\n\nFix ALL failures and return the complete corrected script.`;
  } else {
    userPrompt = `Build the complete CLI tool from this plan:\n${JSON.stringify(plan, null, 2)}`;
  }

  const code = await claude(system, userPrompt,
    previousCode ? "Fixing failures" : "Generating CLI code"
  );

  log("success", `Code generated (${code.split("\n").length} lines)`);
  return code;
}

// ─── Step 3: Test ─────────────────────────────────────────────────────────────

function runTests(plan, toolFile) {
  banner("STEP 3 — Running Test Suite");

  const results = { passed: 0, failed: 0, failures: [] };

  for (const tc of plan.testCases) {
    log("step", `Test ${tc.id}: ${tc.description}`);

    // Setup
    for (const cmd of (tc.setupSteps || [])) {
      try { execSync(cmd, { stdio: "pipe" }); } catch (_) {}
    }

    // Build the command — replace TOOL_FILE with actual path
    const rawCmd = tc.command.replace(/TOOL_FILE/g, toolFile);
    const parts  = rawCmd.split(/\s+/);
    const bin    = parts[0];
    const args   = parts.slice(1);

    const result = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env },
    });

    const stdout   = (result.stdout || "").trim();
    const stderr   = (result.stderr || "").trim();
    const combined = stdout + "\n" + stderr;
    const exitCode = result.status ?? -1;

    let passed = true;
    const reasons = [];

    // Check exit code
    if (exitCode !== tc.expectExitCode) {
      passed = false;
      reasons.push(`Exit code: expected ${tc.expectExitCode}, got ${exitCode}`);
    }

    // Check expected output
    for (const expected of (tc.expectOutputContains || [])) {
      if (!combined.includes(expected)) {
        passed = false;
        reasons.push(`Missing expected output: "${expected}"`);
      }
    }

    // Check forbidden output
    for (const forbidden of (tc.expectOutputNotContains || [])) {
      if (combined.includes(forbidden)) {
        passed = false;
        reasons.push(`Found forbidden output: "${forbidden}"`);
      }
    }

    // Teardown
    for (const cmd of (tc.teardownSteps || [])) {
      try { execSync(cmd, { stdio: "pipe" }); } catch (_) {}
    }

    if (passed) {
      log("success", `  PASSED`);
      results.passed++;
    } else {
      log("error", `  FAILED: ${reasons.join("; ")}`);
      log("dim" in c ? "info" : "info", `  stdout: ${stdout.slice(0, 200)}`);
      results.failed++;
      results.failures.push({
        id: tc.id,
        description: tc.description,
        command: rawCmd,
        reasons,
        stdout: stdout.slice(0, 500),
        stderr: stderr.slice(0, 500),
      });
    }
  }

  process.stderr.write(`\n${c.bold}Results: ${c.green}${results.passed} passed${c.reset}, ${results.failed > 0 ? c.red : c.green}${results.failed} failed${c.reset}\n\n`);
  return results;
}

// ─── Step 4: Install ──────────────────────────────────────────────────────────

function installTool(code, plan, outputDir, customName) {
  banner("STEP 4 — Installing");

  const name     = customName || plan.name;
  const expanded = outputDir.replace(/^~/, os.homedir());
  fs.mkdirSync(expanded, { recursive: true });

  const dest = path.join(expanded, `${name}.js`);
  fs.writeFileSync(dest, code, "utf8");
  fs.chmodSync(dest, 0o755);

  log("success", `Installed to: ${dest}`);

  // Also write a zero-dep shell shim if the output dir is on PATH
  const shimPath = path.join(expanded, name);
  const shim = `#!/bin/sh\nexec node "${dest}" "$@"\n`;
  fs.writeFileSync(shimPath, shim, "utf8");
  fs.chmodSync(shimPath, 0o755);
  log("success", `Shell shim created: ${shimPath}`);
  log("info", `Add ${expanded} to your PATH to call it as: ${name} <args>`);

  return dest;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.description) {
    process.stderr.write([
      `${c.bold}cli-forge${c.reset} — AI-powered master CLI builder`,
      "",
      `${c.bold}Usage:${c.reset}`,
      `  node cli-forge.js "<description>" [options]`,
      "",
      `${c.bold}Options:${c.reset}`,
      `  --output, -o <dir>   Where to install the built CLI (default: cwd)`,
      `  --name,   -n <name>  Override the CLI name`,
      "",
      `${c.bold}Examples:${c.reset}`,
      `  node cli-forge.js "a tool that bulk-renames files by pattern" --output ~/bin`,
      `  node cli-forge.js "a markdown to HTML converter" -o /usr/local/bin -n md2html`,
      "",
      `${c.bold}Requires:${c.reset} ANTHROPIC_API_KEY environment variable`,
      "",
    ].join("\n"));
    process.exit(0);
  }

  banner("CLI FORGE — AI-Powered CLI Builder");
  log("info", `Building: "${args.description}"`);
  log("info", `Output:   ${args.output}`);
  if (args.name) log("info", `Name:     ${args.name}`);

  // ── Phase 1: Plan ──
  const plan = await planTool(args.description);

  // Write plan to a temp file for reference
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "cli-forge-"));
  const planFile = path.join(tmpDir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  log("info", `Plan saved to: ${planFile}`);

  // ── Phase 2+3+fix loop ──
  let code         = null;
  let testResults  = null;
  let cycle        = 0;

  while (cycle < MAX_CYCLES) {
    cycle++;

    // Build (or fix)
    const failureSummary = testResults
      ? testResults.failures.map(f =>
          `Test ${f.id} (${f.description}):\n  Reasons: ${f.reasons.join("; ")}\n  stdout: ${f.stdout}\n  stderr: ${f.stderr}`
        ).join("\n\n")
      : null;

    code = await buildTool(plan, code, failureSummary);

    // Write to temp file for testing
    const toolFile = path.join(tmpDir, `${plan.name}.js`);
    fs.writeFileSync(toolFile, code, "utf8");
    fs.chmodSync(toolFile, 0o755);

    // Test
    if (plan.testCases.length === 0) {
      log("warn", "No test cases in plan — skipping tests.");
      break;
    }

    testResults = runTests(plan, toolFile);

    if (testResults.failed === 0) {
      log("success", `All tests passed on cycle ${cycle}!`);
      break;
    }

    if (cycle < MAX_CYCLES) {
      log("warn", `Cycle ${cycle}/${MAX_CYCLES} — ${testResults.failed} test(s) failed. Asking Claude to fix...`);
    } else {
      log("error", `Reached max cycles (${MAX_CYCLES}). Installing best available version with ${testResults.failed} failing test(s).`);
    }
  }

  // ── Phase 4: Install ──
  const installedPath = installTool(code, plan, args.output, args.name);

  // Final summary
  banner("DONE");
  log("success", `CLI "${args.name || plan.name}" is ready at: ${installedPath}`);
  if (testResults) {
    log("info", `Final test results: ${testResults.passed} passed, ${testResults.failed} failed`);
  }
  log("info", `Plan JSON: ${planFile}`);

  process.exit(testResults && testResults.failed > 0 ? 1 : 0);
}

main().catch(e => die(e.message));
