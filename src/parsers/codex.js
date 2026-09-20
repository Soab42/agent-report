// src/parsers/codex.js
// Codex CLI: ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl
// Wrapped in {timestamp, type, payload:{...}}

import path from 'node:path';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, extractText, parseTs, listJsonl, setFirstMessage } from '../utils.js';

const CODEX_TOOL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const CODEX_INJECTED = ['<environment_context>', '<permissions instructions>', '<user_instructions>'];

export async function parseCodex(root) {
  const events = [];
  const sessions = [];
  const sessDir = path.join(root, 'sessions');
  const files = (await listJsonl(sessDir)).sort();
  const results = await Promise.all(files.map(f => parseCodexFile(f)));
  for (const { events: evs, sessions: ss } of results) {
    for (const e of evs) events.push(e);
    for (const s of ss) sessions.push(s);
  }
  return { events, sessions };
}

async function parseCodexFile(fpath) {
  const events = [];
  const recs = [];
  for await (const r of readJsonl(fpath)) recs.push(r);
  if (!recs.length) return { events, sessions: [] };

  let sid = path.basename(fpath, '.jsonl');
  const s = sess({ source: 'codex', id: sid });
  let model = '';
  let uturn = 0, aturn = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    const rtype = rec.type || '';
    const p = rec.payload || {};
    if (typeof p !== 'object') continue;
    const ts = parseTs(rec.timestamp || p.timestamp);
    updateTs(s, ts);

    if (rtype === 'session_meta') {
      if (p.id) { sid = p.id; s.id = sid; }
      if (p.cwd && !s.cwd) s.cwd = p.cwd;
      if (p.originator && !s.entrypoint) s.entrypoint = p.originator;
      continue;
    }
    if (rtype === 'turn_context') {
      if (p.model) {
        model = p.model;
        if (!s.models.includes(model)) s.models.push(model);
      }
      if (p.cwd && !s.cwd) s.cwd = p.cwd;
      continue;
    }
    if (rtype !== 'response_item') continue;

    const ptype = p.type || '';
    if (ptype === 'message') {
      const role = p.role || '';
      const text = extractText(p.content).trim();
      const cwdNow = s.cwd || '';
      if (role === 'user') {
        if (CODEX_INJECTED.some(prefix => text.startsWith(prefix))) continue;
        uturn++;
        setFirstMessage(s, text);
        events.push(ev({ source: 'codex', t: 'user', ts, sid, len: text.length, cwd: cwdNow }));
      } else if (role === 'assistant') {
        aturn++;
        events.push(ev({ source: 'codex', t: 'assistant', ts, sid, out: text.length, model, cwd: cwdNow }));
      }
      // role === 'developer' → ignore
    } else if (ptype === 'reasoning') {
      s.thinking_count = (s.thinking_count || 0) + 1;
      events.push(ev({ source: 'codex', t: 'assistant', ts, sid, model, thinking: 1, cwd: s.cwd || '' }));
    } else if (CODEX_TOOL_TYPES.has(ptype)) {
      const toolName = p.name || ptype;
      s.tools_used[toolName] = (s.tools_used[toolName] || 0) + 1;
      events.push(ev({ source: 'codex', t: 'assistant', ts, sid, model, tools: [toolName], cwd: s.cwd || '' }));
    }
  }
  if (!s.models.length) s.models = ['codex'];
  s.user_turns = uturn;
  s.assistant_turns = aturn;
  const sessions = (uturn + aturn > 0) ? [s] : [];
  return { events, sessions };
}
