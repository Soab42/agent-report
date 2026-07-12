// src/pricing.js
// Anthropic pricing — first-party rates, USD per 1M tokens.
// Mirrors the RATES table in claude_analyzer.py (lines 1215-1241).

export const RATES = {
  'claude-fable-5':    { input: 10,  output: 50, cr: 1.00, cw: 12.50 },
  'claude-opus-4-8':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-7':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-6':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-5':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-1':   { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-opus-4':     { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-opus-3':     { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-sonnet-4-6': { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-sonnet-4-5': { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-sonnet-4':   { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-haiku-4-5':  { input:  1,  output:  5, cr: 0.10, cw:  1.25 },
  'claude-3-5-haiku':  { input:  0.8, output: 4, cr: 0.08, cw: 1.00 },
  'claude-3-haiku':    { input:  0.25, output: 1.25, cr: 0.03, cw: 0.30 },
};

const DEFAULT_RATE = RATES['claude-opus-4-8'];

export function rateFor(model) {
  // null = not a priceable Claude model (qwen / synthetic / unknown third-party)
  if (!model) return null;
  const id = String(model).replace(/^(anthropic|us|eu|apac)\./, '');
  for (const k of Object.keys(RATES)) {
    if (id.startsWith(k)) return RATES[k];
  }
  return id.startsWith('claude-') ? DEFAULT_RATE : null;
}

export function eventCost(ev) {
  if (ev.source !== 'claude') return 0;
  const r = rateFor(ev.model);
  if (!r) return 0;
  return (
    (ev.inp || 0) * r.input +
    (ev.out || 0) * r.output +
    (ev.cr  || 0) * r.cr +
    (ev.cw  || 0) * r.cw
  ) / 1e6;
}

export function sessionCost(s) {
  if (s.source !== 'claude') return null;
  const m = (s.models && s.models[0]) || '';
  const r = rateFor(m);
  if (!r) return null;
  return (
    (s.input_tokens || 0) * r.input +
    (s.output_tokens || 0) * r.output +
    (s.cache_read || 0) * r.cr +
    (s.cache_create || 0) * r.cw
  ) / 1e6;
}
