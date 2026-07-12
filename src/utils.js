// src/utils.js
// Helpers (mirrors claude_analyzer.py helpers + reading primitives)

import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

export function parseTs(ts) {
  if (ts == null) return null;
  try {
    if (typeof ts === 'number') {
      if (ts > 1e12) ts /= 1000;            // ms → s
      return new Date(ts * 1000).toISOString();
    }
    const s = String(ts).trim().replace(/Z$/, '+00:00');
    // validate then return normalized ISO
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

export async function readJson(p) {
  try {
    const text = await fs.readFile(p, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function* readJsonl(p) {
  let stream;
  try {
    stream = createReadStream(p, { encoding: 'utf8' });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* skip malformed line */
    }
  }
}

export function extractText(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(extractText).filter(Boolean).join(' ');
  if (typeof val === 'object') {
    return extractText(val.text ?? val.content ?? val.value ?? '');
  }
  return '';
}

export function shortenPath(p, n = 55) {
  if (!p) return '';
  if (p.length <= n) return p;
  const parts = p.split('/').filter(Boolean);
  return parts.length >= 2 ? '…/' + parts.slice(-2).join('/') : p;
}

export function fmt(n) {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtDuration(seconds) {
  if (seconds == null || seconds < 0) return '—';
  if (seconds < 60)   return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.floor(seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}

// Find files matching a glob, using fs walk (we avoid extra deps)
export async function walkFiles(dir, predicate, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // skip noisy directories
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walkFiles(full, predicate, acc);
    } else if (e.isFile()) {
      if (predicate(full, e.name)) acc.push(full);
    }
  }
  return acc;
}

export async function listJsonl(root) {
  if (!root) return [];
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  return walkFiles(root, (_p, name) => name.endsWith('.jsonl'));
}

export async function listMd(root) {
  if (!root) return [];
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  return walkFiles(root, (_p, name) => name.endsWith('.md'));
}
