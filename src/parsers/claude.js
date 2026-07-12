// src/parsers/claude.js
// Claude Desktop (Cowork) + Claude Code CLI JSONL
// Mirrors claude_analyzer.py parse_claude (lines 123-203)

import path from 'node:path';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, extractText, parseTs, listJsonl } from '../utils.js';

export async function parseClaude(roots) {
  const events = [];
  const sd = new Map();
  const files = new Set();
  for (const r of roots) {
    for (const f of await listJsonl(r)) files.add(f);
  }
  for (const f of [...files].sort()) {
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
        s.user_turns = (s.user_turns || 0) + 1;
        const cwd = rec.cwd || '';
        const ep  = rec.entrypoint || '';
        if (cwd && !s.cwd) s.cwd = cwd;
        if (ep  && !s.entrypoint) s.entrypoint = ep;
        const text = extractText(rec.message?.content ?? '').trim();
        if (text && !s.first_message) s.first_message = text.slice(0, 200);
        events.push(ev({
          source: 'claude', t: 'user', ts, sid,
          len: text.length, cwd, ep,
        }));
      } else if (rtype === 'assistant') {
        s.assistant_turns = (s.assistant_turns || 0) + 1;
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

        const toolsTurn = [];
        let thinking = 0;
        for (const blk of (msg.content || [])) {
          if (!blk || typeof blk !== 'object') continue;
          if (blk.type === 'tool_use') {
            const tn = blk.name || 'unknown';
            toolsTurn.push(tn);
            s.tools_used[tn] = (s.tools_used[tn] || 0) + 1;
          } else if (blk.type === 'thinking') {
            thinking++;
            s.thinking_count = (s.thinking_count || 0) + 1;
          }
        }
        events.push(ev({
          source: 'claude', t: 'assistant', ts, sid,
          inp, out, cr, cw, model,
          tools: toolsTurn, thinking,
          mcp: rec.attributionMcpServer || '',
          ep: s.entrypoint || '', cwd: s.cwd || '',
        }));
      } else if (rtype === 'last-prompt') {
        if (!s.title && rec.lastPrompt) s.title = String(rec.lastPrompt).slice(0, 200);
      }
    }
  }
  return { events, sessions: [...sd.values()] };
}
