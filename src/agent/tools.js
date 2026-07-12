// src/agent/tools.js
// Async tool executor mirroring myagent.py execute_tool()

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const TOOLS = [
  {
    name: 'bash',
    description: 'Run a bash shell command and return stdout + stderr. Use for scripts, listing files, system state, installs, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'integer', description: 'Timeout in seconds (default 30)', default: 30 },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from disk.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to read' },
        offset: { type: 'integer', description: 'Line number to start reading from (0-indexed)', default: 0 },
        limit: { type: 'integer', description: 'Max number of lines to return', default: 200 },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file on disk.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'Directory path to list', default: '.' },
        pattern: { type: 'string', description: 'Glob pattern to filter (e.g. *.py)', default: '*' },
      },
    },
  },
];

function runBash(command, timeout = 30) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', finished = false;
    const proc = spawn('bash', ['-c', command], { cwd: process.cwd() });
    const timer = setTimeout(() => { if (!finished) { proc.kill('SIGTERM'); } }, timeout * 1000);
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', (code) => {
      finished = true;
      clearTimeout(timer);
      let out = (stdout || '') + (stderr || '');
      if (code !== 0) out += `\n[Exit code: ${code}]`;
      resolve(out.trim() || '(no output)');
    });
    proc.on('error', e => resolve(`[Tool error: ${e.name}: ${e.message}]`));
  });
}

async function readFile(p, offset = 0, limit = 200) {
  const expanded = path.resolve(p.startsWith('~') ? p.replace(/^~/, process.env.HOME || '') : p);
  const text = await fs.readFile(expanded, 'utf8');
  const lines = text.split(/\r?\n/);
  const chunk = lines.slice(offset, offset + limit);
  const total = lines.length;
  return `[${expanded} — lines ${offset + 1}–${offset + chunk.length} of ${total}]\n` +
    chunk.map((l, i) => `${String(offset + i + 1).padStart(4)}  ${l}`).join('\n');
}

async function writeFile(p, content) {
  const expanded = path.resolve(p.startsWith('~') ? p.replace(/^~/, process.env.HOME || '') : p);
  await fs.mkdir(path.dirname(expanded), { recursive: true });
  await fs.writeFile(expanded, content);
  return `Written ${content.length} chars to ${expanded}`;
}

async function listDir(p = '.', pattern = '*') {
  const expanded = path.resolve(p.startsWith('~') ? p.replace(/^~/, process.env.HOME || '') : p);
  const items = await fs.readdir(expanded).catch(() => []);
  // tiny glob: only "*" supported, otherwise return all
  const filtered = pattern === '*' ? items : items.filter(n => n.includes(pattern.replace(/\*/g, '')));
  const lines = [];
  for (const item of filtered.slice(0, 100)) {
    try {
      const st = await fs.stat(path.join(expanded, item));
      const kind = st.isDirectory() ? 'DIR ' : 'FILE';
      const size = st.isFile() ? String(st.size).padStart(10) : '          ';
      lines.push(`${kind}  ${size}  ${item}`);
    } catch {}
  }
  return lines.join('\n') || '(empty directory)';
}

export async function executeTool(name, inputs = {}) {
  try {
    if (name === 'bash')     return await runBash(inputs.command, inputs.timeout);
    if (name === 'read_file') return await readFile(inputs.path, inputs.offset, inputs.limit);
    if (name === 'write_file') return await writeFile(inputs.path, inputs.content);
    if (name === 'list_dir')  return await listDir(inputs.path, inputs.pattern);
    return `Unknown tool: ${name}`;
  } catch (e) {
    return `[Tool error: ${e.name}: ${e.message}]`;
  }
}
