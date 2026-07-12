// src/parsers/puku.js
// Puku CLI: ~/.puku-cli/projects/**/*.jsonl

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, extractText, parseTs, listJsonl } from '../utils.js';

export async function parsePuku(root) {
  const events = [];
  const sessions = [];
  try {
    await fs.access(root);
  } catch {
    return { events, sessions };
  }
  const files = (await listJsonl(root)).sort();
  for (const f of files) await parsePukuFile(f, events, sessions);
  return { events, sessions };
}

async function parsePukuFile(fpath, events, sessions) {
  const recs = [];
  for await (const r of readJsonl(fpath)) recs.push(r);
  if (!recs.length) return;

  const sid = path.basename(fpath, '.jsonl');
  const s = sess({ source: 'puku', id: sid });
  let uturn = 0, aturn = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;
    const rtype = rec.type || '';
    const ts = parseTs(rec.timestamp);
    updateTs(s, ts);

    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (!s.entrypoint && rec.entrypoint) s.entrypoint = rec.entrypoint;
    const sCwd = s.cwd || '';
    const sEp  = s.entrypoint || '';

    if (rtype === 'last-prompt') {
      if (!s.title && rec.lastPrompt) s.title = String(rec.lastPrompt).slice(0, 200);
      continue;
    }
    if (rtype === 'user') {
      if (rec.isMeta) continue;                                // harness-injected
      const text = extractText(rec.message?.content ?? '').trim();
      if (text.startsWith('<command-name>') || text.startsWith('<local-command-')) continue;
      uturn++;
      if (text && !s.first_message) s.first_message = text.slice(0, 200);
      events.push(ev({ source: 'puku', t: 'user', ts, sid, len: text.length, cwd: sCwd, ep: sEp }));
      continue;
    }
    if (rtype === 'assistant') {
      const msg = rec.message || {};
      const model = msg.model || '';
      if (model && !s.models.includes(model)) s.models.push(model);

      const usage = msg.usage || {};
      const inp = usage.input_tokens || 0;
      const out = usage.output_tokens || 0;
      const cr  = usage.cache_read_input_tokens || 0;
      const cw  = usage.cache_creation_input_tokens || 0;
      s.input_tokens  = (s.input_tokens  || 0) + inp;
      s.output_tokens = (s.output_tokens || 0) + out;
      s.cache_read    = (s.cache_read    || 0) + cr;
      s.cache_create  = (s.cache_create  || 0) + cw;

      aturn++;
      const toolsTurn = [];
      let thinking = 0;
      for (const blk of (msg.content || [])) {
        if (!blk || typeof blk !== 'object') continue;
        const bt = blk.type || '';
        if (bt === 'tool_use') {
          const tn = blk.name || 'unknown';
          toolsTurn.push(tn);
          s.tools_used[tn] = (s.tools_used[tn] || 0) + 1;
        } else if (bt === 'thinking') {
          thinking++;
          s.thinking_count = (s.thinking_count || 0) + 1;
        }
      }
      events.push(ev({
        source: 'puku', t: 'assistant', ts, sid,
        inp, out, cr, cw, model,
        tools: toolsTurn, thinking, cwd: sCwd, ep: sEp,
      }));
    }
    // system / queue-operation / file-history-snapshot → ignore
  }
  if (!s.models.length) s.models = ['puku-cli'];
  s.user_turns = uturn;
  s.assistant_turns = aturn;
  if (uturn + aturn > 0) sessions.push(s);
}
