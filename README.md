# ai-report

> Generate a single-file HTML dashboard of your AI tool usage — Claude, Gemini CLI,
> Antigravity, ChatGPT exports, Codex CLI, and Puku CLI — from anywhere on your
> machine. No clones, no dependencies, just a one-liner.

![dashboard preview](https://placehold.co/1200x600/1a1d2e/6c63ff?text=ai-report+dashboard)

---

## What you get

A self-contained HTML file (`ai-report.html`) with:

- **KPIs** — sessions, messages, tool calls, token usage, daily activity, projects
- **Timeline** — events per day, hour-of-day heatmap, day-of-week split
- **Tools & Models** — top tools (Bash, Read, Edit, …), models used, entrypoints
- **Cost & Cache** — estimated USD spend (Anthropic first-party pricing), cache
  hit rate, savings vs. no-cache, daily cost chart, per-model breakdown
- **Projects** — click any project row to see its sessions, costs, last-active
- **Sessions** — filterable table of every conversation with title, model,
  tokens, cost, duration, working directory
- **Memory & Settings** — your Claude memory files and config
- **Filters** — Today / This Week / This Month / All Time, plus per-source filter

Open the file in any browser. No server, no JS framework build, no internet needed
after the dashboard is generated.

---

## Quick start (no clone, no setup)

```bash
# 1. install the wrapper
curl -fsSL https://raw.githubusercontent.com/Soab42/agent-report/main/ai-report \
  -o ~/.local/bin/ai-report
chmod +x ~/.local/bin/ai-report

# 2. make sure ~/.local/bin is on PATH (add to ~/.bashrc / ~/.zshrc if not)
export PATH="$HOME/.local/bin:$PATH"

# 3. run it from anywhere
cd ~/projects/my-app
ai-report
```

On first run, `ai-report` downloads `claude_analyzer.py` from this repo and caches
it at `~/.local/share/agent-report/claude_analyzer.py`. Subsequent runs use the
cache and work offline. Re-fetch with `ai-report --update`.

**That's it** — no `git clone`, no `pip install`, no Python packages (stdlib only).
Requires Python ≥ 3.8.

---

## What gets scanned

| Tool                | Source location                                              |
|---------------------|--------------------------------------------------------------|
| Claude Desktop      | `~/.config/Claude/claude-code-sessions/`                     |
|                     | `~/.config/Claude/local-agent-mode-sessions/`                |
| Claude Code CLI     | `~/.claude/projects/`                                        |
| Gemini CLI          | `~/.gemini/tmp/<project>/chats/*.jsonl`                      |
| Antigravity IDE     | `~/.gemini/antigravity-ide/brain/<convId>/.system_generated/logs/transcript.jsonl` |
| Antigravity CLI     | `~/.gemini/antigravity-cli/brain/<convId>/.../transcript.jsonl` |
| Codex CLI           | `~/.codex/sessions/**/*.jsonl`                               |
| Puku CLI            | `~/.puku-cli/projects/**/*.jsonl`                            |
| ChatGPT             | `~/Downloads/conversations.json` (auto-detected)             |

All paths are also picked up under `$HOME` regardless of username.

---

## Usage

```
ai-report [OPTIONS]

  -o, --output FILE    Write report to FILE   (default: ./ai-report.html)
  --no-open            Build but don't open the browser
  --update             Re-download claude_analyzer.py from GitHub
  -h, --help           Show help
```

Any other flag is forwarded to `claude_analyzer.py`. Useful ones:

```
--no-claude           Skip Claude sources
--no-gemini           Skip Gemini CLI
--no-antigravity      Skip Antigravity IDE + CLI
--no-codex            Skip Codex CLI
--no-puku             Skip Puku CLI
--chatgpt PATH        Path to a ChatGPT conversations.json export
--path PATH           Extra root directory to scan
-v, --verbose         Print every scanned folder
```

Time-range filtering (Today / This Week / This Month / All Time) lives inside
the generated dashboard — open the HTML and click the period buttons at the top.
There is no `--today` / `--week` CLI flag.

Examples:

```bash
# only show this morning's Puku-CLI sessions in the dashboard,
# then click "Today" in the HTML to filter
ai-report --no-claude --no-gemini --no-antigravity --no-codex

# include a manually-downloaded ChatGPT export
ai-report --chatgpt ~/Downloads/conversations.json

# scan an extra directory
ai-report --path /mnt/shared/logs
```

---

## Run it from any working directory

Because `ai-report` is a single shell script on your `$PATH`, it works the same
from any folder. The report file is written to your current directory by default:

```bash
cd ~/work/project-a && ai-report      # → ./ai-report.html
cd ~/work/project-b && ai-report      # → ./ai-report.html
cd ~ && ai-report -o ~/weekly.html   # → ~/weekly.html
```

This makes it convenient to compare per-project activity, or to drop a report
into a project folder to share.

---

## Manual install (alternative to curl-pipe)

If you prefer to clone once and run from a local copy:

```bash
git clone https://github.com/Soab42/agent-report.git ~/agent-report
export PATH="$HOME/agent-report:$PATH"
ln -sf ~/agent-report/ai-report ~/.local/bin/ai-report
```

With a local clone, `ai-report` automatically finds `claude_analyzer.py` next to
itself and never hits the network.

---

## Requirements

- **Python ≥ 3.8** (3.10+ recommended). Check with `python3 --version`.
- **A POSIX shell** — bash, zsh, dash. macOS users get bash by default.
- **`curl` or `wget`** — only needed for the very first run (or `--update`).
- **`xdg-open`** (Linux) or **`open`** (macOS) — only for the auto-open behavior.

No Python packages are installed. The analyzer uses only the standard library.

---

## Updating

```bash
ai-report --update    # re-download the latest claude_analyzer.py
```

After updating, your next report will include any new source parsers or
dashboard features.

---

## Uninstall

```bash
rm ~/.local/bin/ai-report
rm -rf ~/.local/share/agent-report   # cached analyzer
```

That's all — no system files, no config, no Python packages to remove.

---

## Troubleshooting

**"python >= 3.8 not found"** — Install Python 3 from your distro / python.org
and ensure `python3` is on PATH.

**"download failed"** — You're offline or GitHub is unreachable. Reconnect and
re-run, or do the manual install (clone once locally) so subsequent runs work
without network.

**Empty dashboard** — `ai-report` only sees data the AI tools have already
written to disk. If you've never used one of the supported tools in that
location, the corresponding source simply shows 0 sessions.

**Wrong / stale data** — Some tools write incrementally; close the tool or wait
a few seconds for it to flush its logs, then re-run.

**Browser doesn't auto-open** — Pass `--no-open` and open the HTML file manually,
or install `xdg-open` (Linux) / ensure `open` works (macOS).

---

## How it works

`ai-report` is a thin shell wrapper (~150 lines) that:

1. Finds Python ≥ 3.8 on your system
2. Downloads `claude_analyzer.py` from this repo on first run, caches it under
   `~/.local/share/agent-report/`
3. Runs the analyzer with your flags — it scans each AI tool's local log
   directory, normalizes everything into events + sessions, and emits a single
   self-contained HTML file (Chart.js loaded from CDN, all data inlined)
4. Opens the HTML in your default browser

The analyzer is one Python file, ~2,300 lines, no external dependencies. It
already knows the JSON schemas of Claude Desktop, Claude Code, Gemini CLI,
Antigravity, Codex, and Puku CLI.

---

## License

MIT — do whatever you want with it.

## Author

Soab Mahmud Syfuddhin <syfuddhin@gmail.com>