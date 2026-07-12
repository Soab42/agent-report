// src/parsers/index.js
// Orchestrator: runs all enabled source parsers concurrently and produces a unified state.

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { parseClaude } from './claude.js';
import { parseGemini } from './gemini.js';
import { parseAntigravity } from './antigravity.js';
import { parseChatgpt } from './chatgpt.js';
import { parseCodex } from './codex.js';
import { parsePuku } from './puku.js';
import { findMemoryFiles, analyzeMemory } from './memory.js';
import { analyzeSettings } from './settings.js';

export const SOURCE_COLORS = {
  claude:      '#6c63ff',
  gemini:      '#1a73e8',
  antigravity: '#00c4b4',
  chatgpt:     '#10a37f',
  codex:       '#f97316',
  puku:        '#e879f9',
};
export const SOURCE_LABELS = {
  claude:      'Claude',
  gemini:      'Gemini CLI',
  antigravity: 'Antigravity',
  chatgpt:     'ChatGPT',
  codex:       'Codex',
  puku:        'Puku CLI',
};

function log(line) {
  process.stdout.write(line + '\n');
}

async function dirExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function resolveSource(name, include, home) {
  switch (name) {
    case 'claude': {
      const desktop = path.join(home, '.config', 'Claude');
      const subs = ['claude-code-sessions', 'local-agent-mode-sessions'].map(s => path.join(desktop, s));
      const subPresent = await Promise.all(subs.map(dirExists));
      const roots = subs.filter((_, i) => subPresent[i]);
      if (!roots.length && await dirExists(desktop)) roots.push(desktop);
      const cli = path.join(home, '.claude', 'projects');
      if (await dirExists(cli)) roots.push(cli);
      else { const cli2 = path.join(home, '.claude'); if (await dirExists(cli2)) roots.push(cli2); }
      for (const extra of (include.paths || [])) if (await dirExists(extra)) roots.push(extra);
      return roots.length ? { label: `🟣 Claude: scanning ${roots.length} folder(s)…`,
                              sub: roots.length + ' folder(s)',
                              path: roots.join(' | '),
                              run: () => parseClaude(roots) } : { missing: '🟣 Claude: no folders found' };
    }
    case 'gemini': {
      const root = path.join(home, '.gemini');
      return (await dirExists(root))
        ? { label: `🔵 Gemini CLI: scanning ${root} …`,
            sub: root, path: path.join(root, 'tmp/*/chats'),
            run: () => parseGemini(root) }
        : { missing: '🔵 Gemini CLI: ~/.gemini/ not found' };
    }
    case 'antigravity': {
      const geminiRoot = path.join(home, '.gemini');
      const agDirs = [
        path.join(geminiRoot, 'antigravity-ide', 'brain'),
        path.join(geminiRoot, 'antigravity-cli', 'brain'),
      ];
      const present = (await Promise.all(agDirs.map(dirExists))).some(Boolean);
      return present
        ? { label: '🩵 Antigravity: scanning IDE + CLI transcripts…',
            sub: '', path: path.join(geminiRoot, 'antigravity-{ide,cli}/brain'),
            run: () => parseAntigravity(geminiRoot) }
        : { missing: '🩵 Antigravity: no folders found in ~/.gemini/' };
    }
    case 'chatgpt': {
      const paths = [...(include.chatgpt || [])];
      const bases = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents')];
      for (const base of bases) {
        const direct = path.join(base, 'conversations.json');
        if (await dirExists(direct) && !paths.includes(direct)) paths.push(direct);
        try {
          const entries = await fs.readdir(base);
          await Promise.all(entries.map(async (e) => {
            const f = path.join(base, e, 'conversations.json');
            if (await dirExists(f) && !paths.includes(f)) paths.push(f);
          }));
        } catch {}
      }
      return paths.length
        ? { label: `🟢 ChatGPT: ${paths.length} file(s)…`,
            sub: '', path: paths.join(' | '),
            run: () => parseChatgpt(paths) }
        : { missing: '🟢 ChatGPT: no conversations.json found\n   Export at chat.openai.com → Settings → Data Controls → Export data' };
    }
    case 'codex': {
      const root = path.join(home, '.codex');
      return (await dirExists(root))
        ? { label: `🟠 Codex CLI: scanning ${root} …`,
            sub: root, path: path.join(root, 'sessions'),
            run: () => parseCodex(root) }
        : { missing: '🟠 Codex CLI: ~/.codex/ not found' };
    }
    case 'puku': {
      const root = path.join(home, '.puku-cli', 'projects');
      return (await dirExists(root))
        ? { label: `🩷 Puku CLI: scanning ${root} …`,
            sub: root, path: root,
            run: () => parsePuku(root) }
        : { missing: '🩷 Puku CLI: ~/.puku-cli/projects/ not found' };
    }
  }
  return null;
}

export async function scan({ verbose = false, include = {} } = {}) {
  const home = os.homedir();
  const allEvents = [];
  const allSessions = [];
  const scanInfo = { sources: {} };

  const sourceNames = ['claude', 'gemini', 'antigravity', 'chatgpt', 'codex', 'puku'];
  const enabled = sourceNames.filter(n => include[n] !== false);

  // Resolve every source's roots and emit logs up front, in deterministic order.
  const resolved = await Promise.all(
    enabled.map(async (name) => {
      const spec = await resolveSource(name, include, home);
      if (!spec) return null;
      if (spec.run) {
        log(spec.label);
        if (verbose && spec.sub) log(`    ${spec.sub}`);
      } else if (spec.missing) {
        log(spec.missing);
      }
      return { name, spec };
    })
  );

  const parseJobs = resolved
    .filter((r) => r && r.spec.run)
    .map(async ({ name, spec }) => {
      try {
        const { events, sessions } = await spec.run();
        log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
        return { name, events, sessions, path: spec.path };
      } catch (e) {
        log(`    ⚠ ${name}: ${e.message}`);
        return { name, events: [], sessions: [], path: spec.path };
      }
    });

  const memRoots = [];
  for (const sub of ['claude-code-sessions', 'local-agent-mode-sessions', 'projects']) {
    for (const base of [path.join(home, '.config', 'Claude'), path.join(home, '.claude')]) {
      const p = path.join(base, sub);
      if (await dirExists(p)) memRoots.push(p);
    }
  }
  if (!memRoots.length) {
    for (const base of [path.join(home, '.config', 'Claude'), path.join(home, '.claude')]) {
      if (await dirExists(base)) memRoots.push(base);
    }
  }
  const codexMem = path.join(home, '.codex', 'memories');
  if (await dirExists(codexMem)) memRoots.push(codexMem);

  const memJob = (async () => {
    const memFiles = await findMemoryFiles(memRoots);
    const memory = await analyzeMemory(memFiles);
    const settings = await analyzeSettings(memRoots);
    return { memory, settings };
  })();

  const [parseResults, { memory, settings }] = await Promise.all([
    Promise.all(parseJobs),
    memJob,
  ]);

  for (const { name, events, sessions, path } of parseResults) {
    allEvents.push(...events);
    allSessions.push(...sessions);
    scanInfo.sources[name] = { events: events.length, sessions: sessions.length, path };
  }

  return {
    events: allEvents,
    sessions: allSessions,
    memory,
    settings,
    scan: scanInfo,
    generatedAt: new Date().toISOString(),
  };
}
