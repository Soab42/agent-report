// src/agent/pricing.js
// Per-model pricing for the MyAgent CLI cost display.

export const PRICING = {
  'claude-opus-4-8':           { input: 15.0, output: 75.0, cache_read: 1.50, cache_write: 18.75 },
  'claude-sonnet-4-6':         { input:  3.0, output: 15.0, cache_read: 0.30, cache_write:  3.75 },
  'claude-haiku-4-5-20251001': { input:  0.8, output:  4.0, cache_read: 0.08, cache_write:  1.00 },
  'claude-fable-5':            { input:  3.0, output: 15.0, cache_read: 0.30, cache_write:  3.75 },
};

export function estimateCost(model, usage) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const M = 1_000_000;
  const actual = (
    usage.inp * p.input / M +
    usage.out * p.output / M +
    usage.cr  * p.cache_read / M +
    usage.cw  * p.cache_write / M
  );
  const noCache = (
    (usage.inp + usage.cr + usage.cw) * p.input / M +
    usage.out * p.output / M
  );
  return [actual, noCache];
}
