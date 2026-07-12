// src/parsers/chatgpt.js
// ChatGPT conversations.json export

import { ev, sess } from '../schema.js';
import { readJson, extractText, parseTs } from '../utils.js';

export async function parseChatgpt(files) {
  const events = [];
  const sessions = [];

  for (const fpath of files) {
    const data = await readJson(fpath);
    let convs;
    if (Array.isArray(data)) convs = data;
    else if (data && typeof data === 'object' && Array.isArray(data.conversations)) convs = data.conversations;
    else continue;

    for (const conv of convs) {
      if (!conv || typeof conv !== 'object') continue;
      const sid   = conv.id || '';
      const title = conv.title || '';
      const cTs   = parseTs(conv.create_time);
      const uTs   = parseTs(conv.update_time);
      const s = sess({ source: 'chatgpt', id: sid, title, start_ts: cTs, end_ts: uTs });
      let uturn = 0, aturn = 0;
      const modelsSeen = new Set();

      const mapping = conv.mapping || {};
      for (const node of Object.values(mapping)) {
        if (!node || typeof node !== 'object') continue;
        const msg = node.message;
        if (!msg || typeof msg !== 'object') continue;
        const role = msg.author?.role || '';
        const ts = parseTs(msg.create_time);
        const ct = msg.content || {};
        const parts = ct.parts ?? ct.text ?? [];
        const text = extractText(parts).trim();
        const meta = msg.metadata || {};
        const model = meta.model_slug || meta.model || msg.model_slug || '';

        if (!text || role === 'system' || role === 'tool') continue;
        if (model) modelsSeen.add(model);

        if (role === 'user') {
          uturn++;
          if (!s.first_message) s.first_message = text.slice(0, 200);
          events.push(ev({ source: 'chatgpt', t: 'user', ts, sid, len: text.length }));
        } else if (role === 'assistant') {
          aturn++;
          events.push(ev({ source: 'chatgpt', t: 'assistant', ts, sid, model, out: text.length }));
        }
      }
      s.user_turns = uturn;
      s.assistant_turns = aturn;
      s.models = [...modelsSeen];
      if (uturn + aturn > 0) sessions.push(s);
    }
  }
  return { events, sessions };
}
