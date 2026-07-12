// src/parsers/antigravity.js
// Antigravity IDE + CLI: brain/<convId>/.system_generated/logs/transcript.jsonl

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, readJson, extractText, parseTs, setFirstMessage } from '../utils.js';

const AG_TOOL_TYPES = new Set([
  'VIEW_FILE', 'CODE_ACTION', 'RUN_COMMAND', 'GREP_SEARCH', 'LIST_DIRECTORY',
  'SEARCH_WEB', 'READ_URL_CONTENT', 'ASK_QUESTION', 'EDIT_FILE', 'WRITE_FILE',
  'BROWSER', 'MEMORY',
]);

function cleanAg(text) {
  if (!text) return '';
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text);
  return (m ? m[1] : text).trim();
}

async function agWorkspaceMap(geminiRoot) {
  const map = new Map();
  for (const sub of ['antigravity-cli', 'antigravity-ide']) {
    const base = path.join(geminiRoot, sub);
    try { await fs.access(base); } catch { continue; }

    // history.jsonl
    const hist = path.join(base, 'history.jsonl');
    try {
      for await (const r of readJsonl(hist)) {
        if (r.conversationId && r.workspace) map.set(r.conversationId, r.workspace);
      }
    } catch { /* missing */ }

    // cache/last_conversations.json
    const cache = path.join(base, 'cache', 'last_conversations.json');
    const data = await readJson(cache);
    if (data && typeof data === 'object') {
      for (const [ws, cid] of Object.entries(data)) {
        if (cid && ws && !map.has(cid)) map.set(cid, ws);
      }
    }
  }
  return map;
}

export async function parseAntigravity(geminiRoot) {
  const events = [];
  const sessions = [];
  const wsMap = await agWorkspaceMap(geminiRoot);

  for (const sub of ['antigravity-cli', 'antigravity-ide']) {
    const brain = path.join(geminiRoot, sub, 'brain');
    let entries;
    try {
      entries = await fs.readdir(brain, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const tpath = path.join(brain, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      try { await fs.access(tpath); } catch { continue; }
      await parseAgTranscript(tpath, ent.name, wsMap.get(ent.name) || '', events, sessions);
    }
  }
  return { events, sessions };
}

async function parseAgTranscript(tpath, cid, workspace, events, sessions) {
  const recs = [];
  for await (const r of readJsonl(tpath)) recs.push(r);
  if (!recs.length) return;

  const s = sess({ source: 'antigravity', id: cid, cwd: workspace, models: ['gemini'] });
  let uturn = 0, aturn = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    const src = rec.source || '';
    const rtype = rec.type || '';
    const ts = parseTs(rec.created_at);
    updateTs(s, ts);

    if (src === 'USER_EXPLICIT' && rtype === 'USER_INPUT') {
      const text = cleanAg(extractText(rec.content));
      uturn++;
      setFirstMessage(s, text);
      events.push(ev({ source: 'antigravity', t: 'user', ts, sid: cid, len: text.length, cwd: workspace }));
    } else if (src === 'MODEL' && rtype === 'PLANNER_RESPONSE') {
      const text = extractText(rec.content).trim();
      const thinking = rec.thinking ? 1 : 0;
      if (thinking) s.thinking_count = (s.thinking_count || 0) + 1;
      aturn++;
      events.push(ev({ source: 'antigravity', t: 'assistant', ts, sid: cid, out: text.length, model: 'gemini', thinking, cwd: workspace }));
    } else if (src === 'MODEL' && AG_TOOL_TYPES.has(rtype)) {
      s.tools_used[rtype] = (s.tools_used[rtype] || 0) + 1;
      events.push(ev({ source: 'antigravity', t: 'assistant', ts, sid: cid, model: 'gemini', tools: [rtype], cwd: workspace }));
    }
  }
  s.user_turns = uturn;
  s.assistant_turns = aturn;
  if (uturn + aturn > 0) sessions.push(s);
}
