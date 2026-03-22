#!/usr/bin/env node
/**
 * tools — CLI God tool browser & launcher
 *
 * Usage:
 *   node tools.js list                     # list all tools from all sources
 *   node tools.js list --source cli-anything
 *   node tools.js list --category ai
 *   node tools.js info <tool-name>         # show details for a tool
 *   node tools.js install <tool-name>      # print install command
 *   node tools.js run appagent learn       # launch AppAgent (learn phase)
 *   node tools.js run appagent run         # launch AppAgent (run phase)
 *   node tools.js sources                  # list registered sources
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ─── ANSI colours ─────────────────────────────────────────────────────────────

const c = {
  reset:   "\x1b[0m", bold:    "\x1b[1m", dim:     "\x1b[2m",
  cyan:    "\x1b[36m", green:  "\x1b[32m", yellow:  "\x1b[33m",
  red:     "\x1b[31m", blue:   "\x1b[34m", magenta: "\x1b[35m",
};

function die(msg) {
  process.stderr.write(`${c.red}[✗]${c.reset} ${msg}\n`);
  process.exit(1);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const TOOLS_DIR      = path.join(__dirname, "tools");
const REGISTRY_FILE  = path.join(TOOLS_DIR, "registry.json");

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) die(`Registry not found: ${REGISTRY_FILE}`);
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
}

function loadAllTools(registry) {
  const tools = [];

  for (const source of registry.sources) {
    const sourceDir = path.resolve(TOOLS_DIR, source.local_path);

    if (source.type === "python-pip" && source.registry) {
      // CLI-Anything style: load its own registry.json
      const regFile = path.resolve(TOOLS_DIR, source.registry);
      if (!fs.existsSync(regFile)) continue;
      const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
      for (const tool of reg.clis) {
        tools.push({ ...tool, _source: source.id, _source_display: source.display_name, _type: "pip" });
      }
    } else if (source.type === "python-script") {
      // AppAgent style: single entry per source
      tools.push({
        name:         source.id,
        display_name: source.display_name,
        description:  source.description,
        requires:     source.requires,
        category:     source.category,
        entry_points: source.entry_points,
        _source:      source.id,
        _source_display: source.display_name,
        _type:        "script",
        _dir:         sourceDir,
      });
    }
  }

  return tools;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdSources(registry) {
  console.log(`\n${c.bold}Registered Sources${c.reset}\n`);
  for (const s of registry.sources) {
    console.log(`  ${c.cyan}${s.id}${c.reset}  ${c.dim}(${s.type})${c.reset}`);
    console.log(`    ${s.description}`);
    console.log(`    repo: ${s.repo}`);
    console.log();
  }
}

function cmdList(tools, opts = {}) {
  let filtered = tools;
  if (opts.source)   filtered = filtered.filter(t => t._source   === opts.source);
  if (opts.category) filtered = filtered.filter(t => t.category  === opts.category);

  if (filtered.length === 0) {
    console.log(`${c.yellow}No tools match your filters.${c.reset}`);
    return;
  }

  // Group by source
  const bySource = {};
  for (const t of filtered) {
    (bySource[t._source_display] = bySource[t._source_display] || []).push(t);
  }

  for (const [src, ts] of Object.entries(bySource)) {
    console.log(`\n${c.bold}${c.cyan}${src}${c.reset}  ${c.dim}(${ts.length} tool${ts.length !== 1 ? "s" : ""})${c.reset}`);
    const catMap = {};
    for (const t of ts) (catMap[t.category || "misc"] = catMap[t.category || "misc"] || []).push(t);
    for (const [cat, catTools] of Object.entries(catMap)) {
      console.log(`\n  ${c.yellow}[${cat}]${c.reset}`);
      for (const t of catTools) {
        const name = (t.display_name || t.name).padEnd(20);
        console.log(`    ${c.green}${name}${c.reset}  ${t.description}`);
      }
    }
  }
  console.log();
}

function cmdInfo(tools, name) {
  const tool = tools.find(t => t.name === name || (t.display_name || "").toLowerCase() === name.toLowerCase());
  if (!tool) die(`Tool not found: ${name}`);

  console.log(`\n${c.bold}${tool.display_name || tool.name}${c.reset}  ${c.dim}[${tool._source_display}]${c.reset}`);
  console.log(`  ${tool.description}`);
  if (tool.category)    console.log(`  Category : ${tool.category}`);
  if (tool.requires)    console.log(`  Requires : ${tool.requires}`);
  if (tool.version)     console.log(`  Version  : ${tool.version}`);
  if (tool.homepage)    console.log(`  Homepage : ${tool.homepage}`);
  if (tool.install_cmd) console.log(`\n  Install:\n    ${c.cyan}${tool.install_cmd}${c.reset}`);
  if (tool.entry_point) console.log(`  Entry point: ${tool.entry_point}`);
  if (tool.entry_points) {
    console.log(`\n  Entry points:`);
    for (const [k, v] of Object.entries(tool.entry_points)) {
      console.log(`    ${k}: ${c.cyan}${v}${c.reset}`);
    }
    console.log(`  Run from: ${tool._dir}`);
  }
  if (tool.skill_md)    console.log(`  Skill doc: ${path.join(TOOLS_DIR, "cli-anything", tool.skill_md)}`);
  console.log();
}

function cmdInstall(tools, name) {
  const tool = tools.find(t => t.name === name);
  if (!tool) die(`Tool not found: ${name}`);

  if (tool._type === "pip") {
    if (!tool.install_cmd) die(`No install command for: ${name}`);
    console.log(`\n${c.cyan}${tool.install_cmd}${c.reset}\n`);
    console.log("Run the above command to install, then use the entry point:");
    console.log(`  ${c.green}${tool.entry_point}${c.reset}\n`);
  } else {
    console.log(`\n${c.yellow}${tool.display_name} is a script-based tool.${c.reset}`);
    console.log(`\nSetup:`);
    console.log(`  cd ${tool._dir}`);
    console.log(`  pip install -r requirements.txt`);
    console.log(`\nRun:`);
    for (const [k, v] of Object.entries(tool.entry_points || {})) {
      console.log(`  ${k}: ${c.cyan}${v}${c.reset}`);
    }
    console.log();
  }
}

function cmdRun(registry, sourceName, entryKey) {
  const source = registry.sources.find(s => s.id === sourceName);
  if (!source) die(`Source not found: ${sourceName}`);
  if (!source.entry_points) die(`${sourceName} has no entry_points defined.`);

  const cmd = source.entry_points[entryKey];
  if (!cmd) die(`Entry point '${entryKey}' not found in ${sourceName}. Available: ${Object.keys(source.entry_points).join(", ")}`);

  const sourceDir = path.resolve(TOOLS_DIR, source.local_path);
  const parts = cmd.split(/\s+/);

  process.stderr.write(`${c.blue}[→]${c.reset} Running: ${cmd} (cwd: ${sourceDir})\n`);
  const result = spawnSync(parts[0], parts.slice(1), {
    cwd:   sourceDir,
    stdio: "inherit",
    env:   process.env,
  });
  process.exit(result.status ?? 1);
}

// ─── Help ──────────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write([
    ``,
    `${c.bold}tools${c.reset} — CLI God tool browser & launcher`,
    ``,
    `${c.bold}Usage:${c.reset}`,
    `  node tools.js list                         list all tools`,
    `  node tools.js list --source cli-anything   filter by source`,
    `  node tools.js list --category ai           filter by category`,
    `  node tools.js sources                      list registered sources`,
    `  node tools.js info <name>                  show tool details`,
    `  node tools.js install <name>               print install steps`,
    `  node tools.js run appagent learn           launch AppAgent (learn phase)`,
    `  node tools.js run appagent run             launch AppAgent (run phase)`,
    ``,
  ].join("\n") + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  const registry = loadRegistry();
  const cmd      = argv[0];

  if (cmd === "sources") {
    cmdSources(registry);
    return;
  }

  const tools = loadAllTools(registry);

  if (cmd === "list") {
    const opts = {};
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--source"   && argv[i + 1]) opts.source   = argv[++i];
      if (argv[i] === "--category" && argv[i + 1]) opts.category = argv[++i];
    }
    cmdList(tools, opts);
    return;
  }

  if (cmd === "info" && argv[1]) {
    cmdInfo(tools, argv[1]);
    return;
  }

  if (cmd === "install" && argv[1]) {
    cmdInstall(tools, argv[1]);
    return;
  }

  if (cmd === "run" && argv[1] && argv[2]) {
    cmdRun(registry, argv[1], argv[2]);
    return;
  }

  printHelp();
}

main();
