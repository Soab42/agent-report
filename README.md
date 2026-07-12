# AI Tools Analyzer — Node.js

> Unified dashboard for every AI conversation you've ever had, running locally in one command.

[![npm](https://img.shields.io/npm/v/ailense)](https://www.npmjs.com/package/ailense)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933)]()

Scans your local AI conversation history across six tools and renders a live, auto-refreshing dashboard with cost breakdowns, tools/models/project analytics, and a built-in Claude agent server:

- **Claude Desktop** (Cowork) + **Claude Code CLI**
- **Gemini CLI**
- **Antigravity IDE + CLI**
- **ChatGPT** exports
- **Codex CLI**
- **Puku CLI**

Plus a built-in **MyAgent** server: an Anthropic-API-powered CLI agent with prompt caching and tool execution.

This is the Node.js rewrite of the original Python `claude_analyzer.py` + `myagent.py`. Same data, same dashboard, but:

- Serves a live dashboard on `http://localhost:4310` (auto-refreshing via SSE)
- Exposes all data as JSON APIs (`/api/kpis`, `/api/sessions`, `/api/cost`, …)
- File watcher re-scans source folders whenever you start a new conversation
- Can also emit a self-contained snapshot HTML (`--snapshot`)

---

## Quick start

### Run with npx (no clone required)

```bash
npx ailense                      # starts on http://localhost:4310
npx ailense --port 8080          # custom port
npx ailense --snapshot report.html  # write a self-contained HTML and exit
```

`npx` downloads the package + its dependencies into a temp cache on first run, then executes the `ailense` bin. Subsequent runs use the cache.

### Or install globally

```bash
npm install -g ailense
ailense                          # same flags as above
```

### Or clone and run from source

```bash
git clone https://github.com/Soab42/agent-report.git
cd agent-report
npm install
cp .env.example .env             # add your ANTHROPIC_API_KEY (optional)
npm start                        # or: node src/index.js
```

Then open <http://localhost:4310>.

For a single offline HTML file (no server):

```bash
ailense --snapshot report.html
xdg-open report.html             # or just open in any browser
```

---

## Publishing (maintainers)

Pushes of tags matching `v*` (e.g. `v0.1.4`) automatically publish to npm via GitHub Actions (`.github/workflows/publish.yml`).

```bash
# 1. make changes, commit
git commit -am "feat: ..."

# 2. bump version + create a matching tag
npm version patch                # → 0.1.4, also creates git tag v0.1.4

# 3. push the tag
git push origin main --follow-tags
```

The workflow uses `NPM_TOKEN` (a granular publish token) from repo secrets. To set it up:

1. npmjs.com → Access Tokens → **Generate New Token** → **Granular** → permissions: *Packages: Read & Write*, scope: *ailense*.
2. GitHub → repo → Settings → Secrets and variables → Actions → New repository secret → name `NPM_TOKEN`, paste the token.

You can also trigger a publish manually from the Actions tab using **Run workflow**.

---

## Where to find things

| Thing | Where |
|---|---|
| Source | <https://github.com/Soab42/agent-report> |
| npm package | <https://www.npmjs.com/package/ailense> |
| Issues | <https://github.com/Soab42/agent-report/issues> |
| License | [MIT](./LICENSE) |

---


---

## What it scans

The parser auto-detects these paths on your machine:

| Source | Default paths |
|---|---|
| Claude Desktop | `~/.config/Claude/claude-code-sessions/`, `~/.config/Claude/local-agent-mode-sessions/` |
| Claude Code CLI | `~/.claude/projects/` (fallback `~/.claude/`) |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.jsonl` |
| Antigravity IDE + CLI | `~/.gemini/antigravity-{ide,cli}/brain/<convId>/.system_generated/logs/transcript.jsonl` |
| ChatGPT export | `~/Downloads/conversations.json`, `~/Desktop/conversations.json`, `~/Documents/conversations.json` (or pass `--chatgpt <file>`) |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` |
| Puku CLI | `~/.puku-cli/projects/**/*.jsonl` |
| Memory files | `*.md` with `type: user|feedback|project|reference` frontmatter under Claude/Codex roots |
| Settings | `settings.json`, `settings.local.json`, `.claude.json` |

Disable a source with `--no-claude`, `--no-gemini`, `--no-antigravity`, `--no-codex`, or `--no-puku`.

---

## CLI flags

```text
ailense                                # start server on $PORT or 4310
ailense --port 8080                    # custom port
ailense --snapshot r.html              # write self-contained HTML report, exit
ailense --no-watch                     # disable file watcher
ailense --verbose                      # verbose source listing
ailense --path /extra/root             # add extra Claude root to scan + watch
ailense --chatgpt FILE                 # path to a ChatGPT conversations.json
ailense --no-claude                    # disable a specific source
                                        # (--no-gemini, --no-antigravity, --no-codex, --no-puku)
```

---

## HTTP API

All endpoints accept `?source=<claude|gemini|antigravity|chatgpt|codex|puku>` and `?period=<today|week|month|all>`.

| Endpoint | Description |
|---|---|
| `GET /` | Dashboard HTML |
| `GET /api/scan` | Per-source scan info (events, sessions, path) |
| `GET /api/kpis` | Aggregate KPIs |
| `GET /api/sessions?limit=&offset=` | Paginated session list |
| `GET /api/sessions/:id` | Full session detail |
| `GET /api/events` | Raw event list |
| `GET /api/cost` | Cost breakdown by model and day |
| `GET /api/projects` | Project activity |
| `GET /api/top` | Top tools/models/projects |
| `GET /api/activity` | Timeline + hourly + weekday |
| `GET /api/memory` | Memory files |
| `GET /api/settings` | Settings files |
| `GET /api/stream` | Server-Sent Events (live updates) |
| `POST /api/agent` | `{task, model?, useTools?}` → run MyAgent once |
| `POST /api/agent/stream` | Same, with SSE stream |

### Example

```bash
curl localhost:4310/api/kpis?source=claude&period=month | jq
curl -X POST localhost:4310/api/agent -H 'Content-Type: application/json' \
     -d '{"task":"list the files in /tmp"}'
```

---

## Pricing

Hard-coded first-party Anthropic rates (USD per 1M tokens). Edit `src/pricing.js` and `public/app.js` (search `RATES`) to customize. Cache reads = 0.1× input, cache writes = 1.25× input (5-min TTL). Non-Claude tools are excluded from cost (they log characters, not priced tokens).

---

## How it works

```
src/
├── index.js              # Express server + file watcher + snapshot mode
├── parsers/              # one parser per source (claude.js, gemini.js, …)
├── routes/api.js         # JSON API endpoints
├── routes/agent.js       # POST /api/agent
├── routes/html.js        # static dashboard
├── agent/                # MyAgent — Claude SDK + tools + JSONL logger
├── schema.js             # normalized event/session schema (mirrors ESRC/SSRC)
├── pricing.js            # RATES table + rateFor()/eventCost()
└── utils.js              # parseTs, extractText, walkFiles, fmt, …

public/
├── index.html            # dashboard markup
├── styles.css            # extracted from build_html <style>
├── app.js                # fetch + render + tab/filter logic
└── chart.umd.min.js      # bundled Chart.js 4.4.1
```

The server maintains an in-memory `state = {events, sessions, memory, settings, scan}` and re-scans affected roots whenever chokidar reports a file change. The browser fetches the JSON over `/api/*` and the dashboard re-renders — no full page reloads.

---

## Requirements

- Node.js ≥ 18
- Optional: `ANTHROPIC_API_KEY` in `.env` to use `/api/agent` (the dashboard itself works without it)

---

## License

MIT
