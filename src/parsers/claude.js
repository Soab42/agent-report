// src/parsers/claude.js
// Claude Desktop (Cowork) + Claude Code CLI JSONL

import path from 'node:path';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, extractText, parseTs, listJsonl, usageFromMessage, contentBlocks, setFirstMessage } from '../utils.js';

// Run file parsing in parallel but isolate per-file state, then merge.
async function parseOne(f) {
  const events = [];
  const sd = new Map();
  let fileSid = null;
  for await (const rec of readJsonl(f)) {
    const rtype = rec.type || '';
    let sid = rec.sessionId || fileSid || path.basename(f, '.jsonl');
    fileSid = sid;

    if (!sd.has(sid)) sd.set(sid, sess({ source: 'claude', id: sid }));
    const s = sd.get(sid);
    const ts = parseTs(rec.timestamp);
    updateTs(s, ts);

    if (rtype === 'user') {
      s.user_turns++;
      const cwd = rec.cwd || '';
      const ep  = rec.entrypoint || '';
      if (cwd && !s.cwd) s.cwd = cwd;
      if (ep  && !s.entrypoint) s.entrypoint = ep;
      const text = extractText(rec.message?.content ?? '').trim();
      setFirstMessage(s, text);
      events.push(ev({
        source: 'claude', t: 'user', ts, sid,
        len: text.length, cwd, ep,
      }));
    } else if (rtype === 'assistant') {
      s.assistant_turns++;
      const msg = rec.message || {};
      const model = msg.model || '';
      if (model && !s.models.includes(model)) s.models.push(model);

      const { inp, out, cr, cw } = usageFromMessage(msg);
      s.input_tokens  += inp;
      s.output_tokens += out;
      s.cache_read    += cr;
      s.cache_create  += cw;

      const { tools, thinking } = contentBlocks(msg.content);
      for (const tn of tools) s.tools_used[tn] = (s.tools_used[tn] || 0) + 1;
      s.thinking_count += thinking;

      events.push(ev({
        source: 'claude', t: 'assistant', ts, sid,
        inp, out, cr, cw, model,
        tools, thinking,
        mcp: rec.attributionMcpServer || '',
        ep: s.entrypoint || '', cwd: s.cwd || '',
      }));
    } else if (rtype === 'last-prompt') {
      if (!s.title && rec.lastPrompt) s.title = String(rec.lastPrompt).slice(0, 200);
    }
  }
  return { events, sessions: [...sd.values()] };
}

export async function parseClaude(roots) {
  const fileSet = new Set();
  for (const r of roots) for (const f of await listJsonl(r)) fileSet.add(f);
  const files = [...fileSet].sort();

  const results = await Promise.all(files.map(parseOne));

  const events = [];
  const sd = new Map();
  for (const { events: evs, sessions: ss } of results) {
    for (const e of evs) events.push(e);
    for (const s of ss) {
      const cur = sd.get(s.id);
      if (cur) mergeSession(cur, s);
      else sd.set(s.id, s);
    }
  }
  return { events, sessions: [...sd.values()] };
}

function mergeSession(a, b) {
  a.user_turns     += b.user_turns;
  a.assistant_turns += b.assistant_turns;
  a.input_tokens    += b.input_tokens;
  a.output_tokens   += b.output_tokens;
  a.cache_read      += b.cache_read;
  a.cache_create    += b.cache_create;
  a.thinking_count  += b.thinking_count;
  for (const [k, v] of Object.entries(b.tools_used)) a.tools_used[k] = (a.tools_used[k] || 0) + v;
  for (const m of b.models) if (!a.models.includes(m)) a.models.push(m);
  if (!a.cwd && b.cwd) a.cwd = b.cwd;
  if (!a.entrypoint && b.entrypoint) a.entrypoint = b.entrypoint;
  if (!a.first_message && b.first_message) a.first_message = b.first_message;
  if (!a.title && b.title) a.title = b.title;
  if (b.start_ts && (!a.start_ts || b.start_ts < a.start_ts)) a.start_ts = b.start_ts;
  if (b.end_ts   && (!a.end_ts   || b.end_ts   > a.end_ts))   a.end_ts   = b.end_ts;
}
