// src/parsers/memory.js
// Claude Cowork / Codex memory files (*.md with frontmatter)

import { promises as fs } from 'node:fs';
import { listMd } from '../utils.js';

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

export async function findMemoryFiles(roots) {
  const out = [];
  for (const r of roots) {
    const files = await listMd(r);
    for (const f of files) {
      try {
        const fh = await fs.open(f, 'r');
        try {
          const buf = Buffer.alloc(500);
          await fh.read(buf, 0, 500, 0);
          const head = buf.toString('utf8');
          if (MEMORY_TYPES.some(t => head.includes(`type: ${t}`))) out.push(f);
        } finally {
          await fh.close();
        }
      } catch { /* skip */ }
    }
  }
  return out;
}

export async function analyzeMemory(files) {
  const out = {};
  for (const f of files) {
    try {
      const text = await fs.readFile(f, 'utf8');
      const mType = MEMORY_TYPES.find(t => text.slice(0, 300).includes(`type: ${t}`)) || 'other';
      const nm = /^name:\s*(.+)$/m.exec(text);
      const ds = /^description:\s*(.+)$/m.exec(text);
      if (!out[mType]) out[mType] = [];
      out[mType].push({
        file: f.split('/').pop(),
        name: nm ? nm[1].trim() : f.split('/').pop().replace(/\.md$/, ''),
        description: ds ? ds[1].trim() : '',
      });
    } catch { /* skip */ }
  }
  return out;
}
