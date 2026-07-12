// src/agent/logger.js
// JSONL session logger compatible with the analyzer's parser.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { usageFromMessage } from '../utils.js';

export const DEFAULT_LOG_DIR = path.join(os.homedir(), '.myagent', 'projects');

export class SessionLogger {
  constructor(sessionId, logDir = DEFAULT_LOG_DIR) {
    this.sessionId = sessionId;
    fs.mkdirSync(logDir, { recursive: true });
    this.path = path.join(logDir, `${sessionId}.jsonl`);
    this.totalInput = 0;
    this.totalOutput = 0;
    this.totalCr = 0;
    this.totalCw = 0;
  }

  _write(record) {
    record.sessionId = record.sessionId ?? this.sessionId;
    record.timestamp = record.timestamp ?? new Date().toISOString();
    record.entrypoint = record.entrypoint ?? 'myagent';
    record.cwd = record.cwd ?? process.cwd();
    fs.appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  logUser(text) {
    this._write({ type: 'user', message: { role: 'user', content: text } });
  }

  logToolResults(results) {
    this._write({ type: 'user', message: { role: 'user', content: results }, toolUseResult: true });
  }

  logAssistant(response) {
    const { inp, out, cr, cw } = usageFromMessage(response);
    this.totalInput  += inp;
    this.totalOutput += out;
    this.totalCr     += cr;
    this.totalCw     += cw;
    const content = (response.content || []).map(b => (typeof b === 'object' ? b : { type: 'text', text: String(b) }));
    this._write({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: response.model,
        content,
        usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cw },
      },
    });
    return { inp, out, cr, cw };
  }

  logLastPrompt(text) {
    this._write({ type: 'last-prompt', lastPrompt: text });
  }

  summary() {
    const total = this.totalInput + this.totalOutput;
    const crPct = (100 * this.totalCr) / Math.max(this.totalInput, 1);
    return `Tokens: ${total.toLocaleString()} total (${this.totalInput.toLocaleString()} in / ${this.totalOutput.toLocaleString()} out)  Cache hit: ${crPct.toFixed(0)}%`;
  }
}
