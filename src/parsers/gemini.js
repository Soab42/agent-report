// src/parsers/gemini.js
// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl
// (NOTE: ~/.gemini/history/ is just file checkpoints, not conversations)

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ev, sess, updateTs } from '../schema.js';
import { readJsonl, extractText, parseTs } from '../utils.js';

export async function parseGemini(root) {
  const events = [];
  const sessions = [];
  const tmpDir = path.join(root, 'tmp');
  try {
    await fs.access(tmpDir);
  } catch {
    return { events, sessions };
  }

  const projectDirs = await fs.readdir(tmpDir, { withFileTypes: true });
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, pd.name, 'chats');
    let files;
    try {
      files = (await fs.readdir(chatsDir)).filter(n => n.endsWith('.jsonl')).sort();
    } catch {
      continue;
    }
    for (const fname of files) {
      const fpath = path.join(chatsDir, fname);
      await parseGeminiChat(fpath, pd.name, events, sessions);
    }
  }
  return { events, sessions };
}

async function parseGeminiChat(fpath, project, events, sessions) {
  const recs = [];
  for await (const r of readJsonl(fpath)) recs.push(r);
  if (!recs.length) return;

  const sid = path.basename(fpath, '.jsonl');
  const s = sess({ source: 'gemini', id: sid, cwd: project });
  let uturn = 0, aturn = 0;

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue;

    // session-meta line
    if (rec.sessionId && !rec.type) {
      if (rec.sessionId) s.id = rec.sessionId;
      updateTs(s, parseTs(rec.startTime));
      updateTs(s, parseTs(rec.lastUpdated));
      continue;
    }

    const rtype = rec.type || '';
    const ts = parseTs(rec.timestamp);
    updateTs(s, ts);

    if (rtype === 'user') {
      const text = extractText(rec.content).trim();
      uturn++;
      if (text && !s.first_message) s.first_message = text.slice(0, 200);
      events.push(ev({ source: 'gemini', t: 'user', ts, sid, len: text.length, cwd: project }));
    } else if (rtype === 'gemini') {
      const text = extractText(rec.content).trim();
      const thoughts = Array.isArray(rec.thoughts) ? rec.thoughts : [];
      const thinking = thoughts.length;
      if (thinking) s.thinking_count = (s.thinking_count || 0) + thinking;
      const m = rec.model || 'gemini';
      if (!s.models.includes(m)) s.models.push(m);
      aturn++;
      events.push(ev({ source: 'gemini', t: 'assistant', ts, sid, out: text.length, model: m, thinking, cwd: project }));
    }
  }
  if (!s.models.length) s.models = ['gemini'];
  s.user_turns = uturn;
  s.assistant_turns = aturn;
  if (uturn + aturn > 0) sessions.push(s);
}
