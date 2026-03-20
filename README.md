# cli-forge

AI-powered CLI builder. Describe a tool in plain English — `cli-forge` plans it exhaustively, writes the code, tests it, fixes failures automatically, and installs it on your machine.

## How it works

1. **Plan** — Claude designs every command, flag, edge case, error state, and a full test suite
2. **Build** — Claude generates a complete, zero-dependency Node.js CLI from that plan
3. **Test** — Every test case runs automatically
4. **Fix loop** — If tests fail, Claude sees the failures, rewrites the code, and retests (up to 5 cycles)
5. **Install** — Saves the final script + a shell shim so you can call it by name from anywhere

## Requirements

- Node.js 18+
- `ANTHROPIC_API_KEY` environment variable

## Installation

```bash
git clone https://github.com/Glizzyking/cli-forge.git
cd cli-forge
export ANTHROPIC_API_KEY=your_key_here
```

No `npm install` needed — cli-forge itself has zero dependencies.

## Usage

```bash
node cli-forge.js "<description>" [options]
```

### Options

| Flag | Alias | Description |
|------|-------|-------------|
| `--output <dir>` | `-o` | Where to install the built CLI (default: current directory) |
| `--name <name>` | `-n` | Override the generated CLI's name |

### Examples

```bash
# Build a file renamer and install it to ~/bin
node cli-forge.js "a tool that bulk-renames files by date" --output ~/bin

# Build a markdown-to-HTML converter with a custom name
node cli-forge.js "a markdown to HTML converter" -o /usr/local/bin -n md2html

# Build a JSON pretty-printer
node cli-forge.js "a tool that pretty-prints and validates JSON files" -o ~/bin
```

After installation, add the output directory to your `PATH` and call your new tool by name:

```bash
export PATH="$HOME/bin:$PATH"
md2html input.md
```

## What gets generated

Each built CLI:
- Uses **only Node.js built-ins** (no npm installs ever)
- Handles `--help` on every command
- Validates all inputs with clear error messages to stderr
- Exits `0` on success, `1` on error
- Comes with a shell shim for direct invocation

The plan JSON is saved to a temp directory so you have a full record of the architecture Claude designed.

## License

MIT
