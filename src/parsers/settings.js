// src/parsers/settings.js
// settings.json, settings.local.json, .claude.json

import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function analyzeSettings(roots) {
  const result = [];
  for (const root of roots) {
    for (const name of ['settings.json', 'settings.local.json', '.claude.json']) {
      const p = path.join(root, name);
      try {
        await fs.access(p);
        const raw = await fs.readFile(p, 'utf8');
        let data;
        try { data = JSON.parse(raw); } catch { continue; }
        // truncate deep nested objects to keep output light
        result.push({ file: p, data });
      } catch { /* not present */ }
    }
  }
  return result;
}
