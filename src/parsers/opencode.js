// src/parsers/opencode.js
// OpenCode CLI: ~/.local/share/opencode/opencode.db (sqlite)
// session / message / part tables, message.data / part.data are JSON blobs.

import { ev, sess, updateTs } from '../schema.js';
import { parseTs, setFirstMessage } from '../utils.js';

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

export async function parseOpencode(dbPath) {
  const events = [];
  const sessions = [];

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const projects = new Map();
    for (const row of db.prepare('select id, worktree from project').all()) {
      projects.set(row.id, row.worktree);
    }

    const sessionRows = db.prepare(
      'select id, project_id, directory, title, model from session'
    ).all();

    const messageStmt = db.prepare(
      'select id, data from message where session_id = ? order by time_created, id'
    );
    const partStmt = db.prepare(
      'select data from part where message_id = ? order by id'
    );

    for (const srow of sessionRows) {
      const sid = srow.id;
      const s = sess({ source: 'opencode', id: sid });
      s.cwd = srow.directory || projects.get(srow.project_id) || '';
      if (srow.title) s.title = String(srow.title).slice(0, 200);
      let uturn = 0, aturn = 0;

      const msgRows = messageStmt.all(sid);
      for (const mrow of msgRows) {
        const msg = parseJson(mrow.data);
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.role || '';
        const ts = parseTs(msg.time?.created);
        updateTs(s, ts);

        const model = msg.modelID || msg.model?.modelID || '';
        if (model && !s.models.includes(model)) s.models.push(model);

        const partRows = partStmt.all(mrow.id);
        let text = '';
        const tools = [];
        let thinking = 0;
        for (const prow of partRows) {
          const part = parseJson(prow.data);
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && part.text) text += part.text;
          else if (part.type === 'reasoning') thinking++;
          else if (part.type === 'tool' && part.tool) tools.push(part.tool);
        }

        if (role === 'user') {
          uturn++;
          setFirstMessage(s, text.trim());
          events.push(ev({ source: 'opencode', t: 'user', ts, sid, len: text.length, cwd: s.cwd }));
        } else if (role === 'assistant') {
          aturn++;
          const tk = msg.tokens || {};
          const inp = tk.input || 0;
          const out = tk.output || 0;
          const cr = tk.cache?.read || 0;
          const cw = tk.cache?.write || 0;
          s.input_tokens  = (s.input_tokens  || 0) + inp;
          s.output_tokens = (s.output_tokens || 0) + out;
          s.cache_read    = (s.cache_read    || 0) + cr;
          s.cache_create  = (s.cache_create  || 0) + cw;
          for (const tn of tools) s.tools_used[tn] = (s.tools_used[tn] || 0) + 1;
          s.thinking_count = (s.thinking_count || 0) + thinking;
          events.push(ev({
            source: 'opencode', t: 'assistant', ts, sid,
            inp, out, cr, cw, model,
            tools, thinking, cwd: s.cwd,
          }));
        }
      }

      if (!s.models.length) s.models = ['opencode'];
      s.user_turns = uturn;
      s.assistant_turns = aturn;
      if (uturn + aturn > 0) sessions.push(s);
    }
  } finally {
    db.close();
  }

  return { events, sessions };
}
