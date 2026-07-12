// src/parsers/index.js
// Orchestrator: runs all parsers in parallel and produces a unified state.

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

export async function scan({ verbose = false, include = {} } = {}) {
  const home = os.homedir();
  const allEvents = [];
  const allSessions = [];
  const scanInfo = { sources: {} };

  // ── Claude Desktop + Claude Code CLI ────────────────────────────────────
  if (include.claude !== false) {
    const claudeRoots = [];
    const desktop = path.join(home, '.config', 'Claude');
    for (const sub of ['claude-code-sessions', 'local-agent-mode-sessions']) {
      const p = path.join(desktop, sub);
      try { await fs.access(p); claudeRoots.push(p); } catch {}
    }
    if (!claudeRoots.length) {
      try { await fs.access(desktop); claudeRoots.push(desktop); } catch {}
    }
    const cli = path.join(home, '.claude', 'projects');
    try { await fs.access(cli); claudeRoots.push(cli); }
    catch {
      const cli2 = path.join(home, '.claude');
      try { await fs.access(cli2); claudeRoots.push(cli2); } catch {}
    }
    for (const extra of (include.paths || [])) {
      try { await fs.access(extra); claudeRoots.push(extra); } catch {}
    }
    if (claudeRoots.length) {
      log(`🟣 Claude: scanning ${claudeRoots.length} folder(s)…`);
      if (verbose) for (const r of claudeRoots) log(`    ${r}`);
      const { events, sessions } = await parseClaude(claudeRoots);
      allEvents.push(...events);
      allSessions.push(...sessions);
      log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
      scanInfo.sources.claude = {
        events: events.length, sessions: sessions.length,
        path: claudeRoots.join(' | '),
      };
    } else {
      log('🟣 Claude: no folders found');
    }
  }

  // ── Gemini CLI ─────────────────────────────────────────────────────────
  if (include.gemini !== false) {
    const geminiRoot = path.join(home, '.gemini');
    try {
      await fs.access(geminiRoot);
      log(`🔵 Gemini CLI: scanning ${geminiRoot} …`);
      const { events, sessions } = await parseGemini(geminiRoot);
      allEvents.push(...events);
      allSessions.push(...sessions);
      log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
      scanInfo.sources.gemini = {
        events: events.length, sessions: sessions.length,
        path: path.join(geminiRoot, 'tmp/*/chats'),
      };
    } catch {
      log('🔵 Gemini CLI: ~/.gemini/ not found');
    }
  }

  // ── Antigravity ────────────────────────────────────────────────────────
  if (include.antigravity !== false) {
    const geminiRoot = path.join(home, '.gemini');
    const agDirs = [
      path.join(geminiRoot, 'antigravity-ide', 'brain'),
      path.join(geminiRoot, 'antigravity-cli', 'brain'),
    ];
    let present = false;
    for (const d of agDirs) { try { await fs.access(d); present = true; break; } catch {} }
    if (present) {
      log('🩵 Antigravity: scanning IDE + CLI transcripts…');
      const { events, sessions } = await parseAntigravity(geminiRoot);
      allEvents.push(...events);
      allSessions.push(...sessions);
      log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
      scanInfo.sources.antigravity = {
        events: events.length, sessions: sessions.length,
        path: path.join(geminiRoot, 'antigravity-{ide,cli}/brain'),
      };
    } else {
      log('🩵 Antigravity: no folders found in ~/.gemini/');
    }
  }

  // ── ChatGPT ────────────────────────────────────────────────────────────
  const chatgptPaths = [...(include.chatgpt || [])];
  for (const base of [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents')]) {
    for (const cand of [path.join(base, 'conversations.json')]) {
      try { await fs.access(cand); if (!chatgptPaths.includes(cand)) chatgptPaths.push(cand); } catch {}
    }
    try {
      const entries = await fs.readdir(base);
      for (const e of entries) {
        const f = path.join(base, e, 'conversations.json');
        try { await fs.access(f); if (!chatgptPaths.includes(f)) chatgptPaths.push(f); } catch {}
      }
    } catch {}
  }
  if (chatgptPaths.length) {
    log(`🟢 ChatGPT: ${chatgptPaths.length} file(s)…`);
    const { events, sessions } = await parseChatgpt(chatgptPaths);
    allEvents.push(...events);
    allSessions.push(...sessions);
    log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
    scanInfo.sources.chatgpt = {
      events: events.length, sessions: sessions.length,
      path: chatgptPaths.join(' | '),
    };
  } else {
    log('🟢 ChatGPT: no conversations.json found');
    log('   Export at chat.openai.com → Settings → Data Controls → Export data');
  }

  // ── Codex ──────────────────────────────────────────────────────────────
  if (include.codex !== false) {
    const codexRoot = path.join(home, '.codex');
    try {
      await fs.access(codexRoot);
      log(`🟠 Codex CLI: scanning ${codexRoot} …`);
      const { events, sessions } = await parseCodex(codexRoot);
      allEvents.push(...events);
      allSessions.push(...sessions);
      log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
      scanInfo.sources.codex = {
        events: events.length, sessions: sessions.length,
        path: path.join(codexRoot, 'sessions'),
      };
    } catch {
      log('🟠 Codex CLI: ~/.codex/ not found');
    }
  }

  // ── Puku CLI ───────────────────────────────────────────────────────────
  if (include.puku !== false) {
    const pukuRoot = path.join(home, '.puku-cli', 'projects');
    try {
      await fs.access(pukuRoot);
      log(`🩷 Puku CLI: scanning ${pukuRoot} …`);
      const { events, sessions } = await parsePuku(pukuRoot);
      allEvents.push(...events);
      allSessions.push(...sessions);
      log(`    ${sessions.length.toLocaleString()} sessions · ${events.length.toLocaleString()} events`);
      scanInfo.sources.puku = {
        events: events.length, sessions: sessions.length,
        path: pukuRoot,
      };
    } catch {
      log('🩷 Puku CLI: ~/.puku-cli/projects/ not found');
    }
  }

  // ── Memory & Settings ──────────────────────────────────────────────────
  const memRoots = [];
  for (const sub of ['claude-code-sessions', 'local-agent-mode-sessions', 'projects']) {
    for (const base of [path.join(home, '.config', 'Claude'), path.join(home, '.claude')]) {
      const p = path.join(base, sub);
      try { await fs.access(p); memRoots.push(p); } catch {}
    }
  }
  if (!memRoots.length) {
    for (const base of [path.join(home, '.config', 'Claude'), path.join(home, '.claude')]) {
      try { await fs.access(base); memRoots.push(base); } catch {}
    }
  }
  const codexMem = path.join(home, '.codex', 'memories');
  try { await fs.access(codexMem); memRoots.push(codexMem); } catch {}

  const memFiles = await findMemoryFiles(memRoots);
  const memory   = await analyzeMemory(memFiles);
  const settings = await analyzeSettings(memRoots);

  return {
    events: allEvents,
    sessions: allSessions,
    memory,
    settings,
    scan: scanInfo,
    generatedAt: new Date().toISOString(),
  };
}
