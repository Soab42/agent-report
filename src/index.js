#!/usr/bin/env node
// src/index.js
// Express server: serves the dashboard, JSON APIs, and SSE updates.

import 'dotenv/config';
import express from 'express';
import chokidar from 'chokidar';
import path from 'node:path';
import os from 'node:os';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scan, SOURCE_COLORS, SOURCE_LABELS } from './parsers/index.js';
import { apiRouter, createBroadcaster } from './routes/api.js';
import { agentRouter } from './routes/agent.js';
import { htmlRouter } from './routes/html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    port: parseInt(process.env.PORT) || 4310,
    snapshot: null,
    noWatch: false,
    verbose: false,
    paths: [],
    chatgpt: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = parseInt(argv[++i]);
    else if (a === '--snapshot' || a === '-s') args.snapshot = argv[++i] || 'ai-report.html';
    else if (a === '--no-watch') args.noWatch = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--path') {
      // collect everything until next flag (or end)
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.paths.push(argv[++i]);
    }
    else if (a === '--chatgpt') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.chatgpt.push(argv[++i]);
    }
    else if (a === '--no-claude')      args.noClaude = true;
    else if (a === '--no-gemini')      args.noGemini = true;
    else if (a === '--no-antigravity') args.noAntigravity = true;
    else if (a === '--no-codex')       args.noCodex = true;
    else if (a === '--no-puku')        args.noPuku = true;
  }
  return args;
}

function help() {
  console.log(`AI Tools Analyzer (Node.js)

Usage:
  node src/index.js                       # start server on port ${process.env.PORT || 4310}
  node src/index.js --port 8080           # custom port
  node src/index.js --snapshot r.html     # write a self-contained HTML report and exit
  node src/index.js --no-watch            # don't watch for file changes
  node src/index.js --verbose             # verbose source listing
  node src/index.js --path /extra/root    # add extra Claude root to scan + watch
  node src/index.js --chatgpt FILE        # path to a ChatGPT conversations.json
  node src/index.js --no-claude           # disable a specific source
                                           # (--no-gemini, --no-antigravity, --no-codex, --no-puku)

Endpoints:
  GET  /                  → dashboard (HTML)
  GET  /api/scan          → scan info per source
  GET  /api/kpis          → aggregate KPIs (?source=&period=)
  GET  /api/sessions      → sessions list (?source=&period=&limit=&offset=)
  GET  /api/sessions/:id  → full session detail
  GET  /api/events        → raw events
  GET  /api/cost          → cost breakdown by model and day
  GET  /api/projects      → project activity
  GET  /api/top           → top tools/models/projects
  GET  /api/activity      → timeline, hourly, weekday
  GET  /api/memory        → memory files
  GET  /api/settings      → settings files (truncated)
  GET  /api/stream        → Server-Sent Events (live updates)
  POST /api/agent         → {task,model?,useTools?} → run MyAgent once
  POST /api/agent/stream  → same, with SSE stream
`);
}

function printBanner(state, port) {
  const u = state.events.filter(e => e.t === 'user').length;
  const a = state.events.filter(e => e.t === 'assistant').length;
  console.log(`\n📊 Total: ${state.sessions.length.toLocaleString()} sessions · ${u.toLocaleString()} user + ${a.toLocaleString()} AI messages`);
  console.log(`\n🏗  Dashboard ready on http://localhost:${port}`);
  console.log('    Period: Today / This Week / This Month / All Time');
  console.log('    Sources: All / Claude / Gemini / Antigravity / ChatGPT / Codex / Puku CLI\n');
  console.log('='.repeat(64));
}

// Snapshot mode: write a self-contained HTML report and exit.
async function snapshotMode(outPath) {
  console.log('='.repeat(64));
  console.log('  AI Tools Unified Analyzer — snapshot mode');
  console.log('='.repeat(64));
  const state = await scan({ verbose: false });
  if (!state.events.length) {
    console.error('\n⚠  No events found from any source.');
    process.exit(1);
  }
  console.log('\n🏗  Building self-contained HTML…');
  const html = buildSnapshotHtml(state);
  await fs.writeFile(outPath, html, 'utf8');
  console.log(`\n✅  Dashboard → ${path.resolve(outPath)}`);
  console.log(`    Size: ${(html.length / 1024).toFixed(0)} KB`);
}

function buildSnapshotHtml(state) {
  // Bundle the data + dashboard JS inline so the file works offline.
  const publicDir = path.join(__dirname, '..', 'public');
  const indexHtml = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const styles    = readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const appJs     = readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const chartJs   = readFileSync(path.join(publicDir, 'chart.umd.min.js'), 'utf8');

  const inlineData = `
const SNAPSHOT = true;
const SNAPSHOT_STATE = ${JSON.stringify(state)};
const SNAPSHOT_COLORS = ${JSON.stringify(SOURCE_COLORS)};
const SNAPSHOT_LABELS = ${JSON.stringify(SOURCE_LABELS)};
`;

  // Inject inline script + replace stylesheet + chart.js with inline versions.
  let html = indexHtml;
  html = html.replace(
    '<link rel="stylesheet" href="/styles.css">',
    `<style>${styles}</style>`,
  );
  html = html.replace(
    '<script src="/chart.umd.min.js"></script>',
    `<script>${chartJs}</script>`,
  );
  html = html.replace(
    '<script src="/app.js" defer></script>',
    `<script>${inlineData}\n${appJs}</script>`,
  );
  return html;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); process.exit(0); }

  if (args.snapshot) {
    await snapshotMode(args.snapshot);
    process.exit(0);
  }

  console.log('='.repeat(64));
  console.log('  AI Tools Unified Analyzer — server mode');
  console.log('='.repeat(64));

  const include = {
    paths: args.paths,
    chatgpt: args.chatgpt,
  };
  if (args.noClaude)      include.claude = false;
  if (args.noGemini)      include.gemini = false;
  if (args.noAntigravity) include.antigravity = false;
  if (args.noCodex)       include.codex = false;
  if (args.noPuku)        include.puku = false;

  let state = await scan({ verbose: args.verbose, include });
  if (!state.events.length) {
    console.error('\n⚠  No events found. The dashboard will be empty.');
  }

  const broadcaster = createBroadcaster();
  const getState = () => state;
  const setState = (s) => { state = s; };

  const app = express();
  app.disable('x-powered-by');

  app.use('/api', apiRouter(getState, broadcaster));
  app.use('/api', agentRouter(broadcaster));
  app.use('/', htmlRouter());

  const server = app.listen(args.port, () => {
    printBanner(state, args.port);
  });

  // File watcher — re-scan affected source on changes
  if (!args.noWatch) {
    const home = os.homedir();
    const watchRoots = [
      path.join(home, '.config', 'Claude'),
      path.join(home, '.claude'),
      path.join(home, '.gemini'),
      path.join(home, '.codex'),
      path.join(home, '.puku-cli'),
      path.join(home, 'Downloads'),
      path.join(home, 'Desktop'),
      path.join(home, 'Documents'),
      ...args.paths,
    ];
    const existing = watchRoots.filter(p => {
      try { return existsSync(p); } catch { return false; }
    });
    const watcher = chokidar.watch(existing, {
      ignoreInitial: true,
      ignored: /(^|[\/\\])\..*|node_modules/,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    let debounce = null;
    const refresh = async (filePath) => {
      console.log(`\n  ⟳ Change detected: ${filePath}`);
      const fresh = await scan({ verbose: false });
      setState(fresh);
      const totalEv = fresh.events.length;
      broadcaster.emit({ type: 'update', generatedAt: fresh.generatedAt, events: totalEv });
      console.log(`  ⟳ State refreshed (${totalEv.toLocaleString()} events)`);
    };
    const onChange = (filePath) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => refresh(filePath).catch(e => console.error('Refresh error:', e)), 800);
    };
    watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    console.log(`\n👁  Watching ${existing.length} root(s) for changes…\n`);

    process.on('SIGINT', () => {
      console.log('\nShutting down…');
      watcher.close();
      server.close(() => process.exit(0));
    });
  } else {
    process.on('SIGINT', () => {
      console.log('\nShutting down…');
      server.close(() => process.exit(0));
    });
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});