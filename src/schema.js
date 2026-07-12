// src/schema.js
// Normalized event/session schema (mirrors claude_analyzer.py ESRC/SSRC)

export const ESRC = [
  'source', 't', 'ts', 'sid', 'len',
  'inp', 'out', 'cr', 'cw', 'model',
  'tools', 'thinking', 'cwd', 'ep', 'mcp',
];

export const SSRC = [
  'source', 'id', 'start_ts', 'end_ts',
  'user_turns', 'assistant_turns',
  'input_tokens', 'output_tokens', 'cache_read', 'cache_create',
  'thinking_count', 'tools_used',
  'models', 'cwd', 'entrypoint', 'first_message', 'title',
];

export function ev(kw = {}) {
  const out = {};
  for (const k of ESRC) out[k] = kw[k] ?? '';
  return out;
}

export function sess(kw = {}) {
  const s = {};
  for (const k of SSRC) s[k] = kw[k];
  s.tools_used      = s.tools_used      || {};
  s.models          = s.models          || [];
  s.user_turns      = s.user_turns      || 0;
  s.assistant_turns = s.assistant_turns || 0;
  return s;
}

export function updateTs(s, ts) {
  if (!ts) return;
  if (!s.start_ts || ts < s.start_ts) s.start_ts = ts;
  if (!s.end_ts   || ts > s.end_ts)   s.end_ts   = ts;
}
