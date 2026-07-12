// src/agent/myagent.js
// Agent class wrapping the Anthropic SDK — port of myagent.py Agent.

import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { TOOLS, executeTool } from './tools.js';
import { SessionLogger } from './logger.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_MODEL = process.env.MYAGENT_MODEL || 'claude-opus-4-8';
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a highly capable AI assistant and software engineer.
You have access to tools that let you run bash commands, read/write files, and search the web.
Be concise. Always use tools when they help — don't just describe what you'd do, do it.
When running bash commands, prefer short targeted commands over long pipelines.
Current working directory: ${process.cwd()}`;

export class Agent {
  constructor({ model = DEFAULT_MODEL, useTools = true, showCost = false, apiKey } = {}) {
    this.model = model;
    this.useTools = useTools;
    this.showCost = showCost;
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
    this.sessionId = randomUUID();
    this.logger = new SessionLogger(this.sessionId);
    this.history = [];
  }

  _system() {
    return [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  }

  _toolsWithCache() {
    if (!this.useTools) return [];
    const tools = TOOLS.map(t => ({ ...t }));
    tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    return tools;
  }

  async _callApi() {
    const kwargs = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this._system(),
      messages: this.history,
    };
    if (this.useTools) kwargs.tools = this._toolsWithCache();
    return await this.client.messages.create(kwargs);
  }

  async send(userText, { onText, onToolUse, onToolResult } = {}) {
    this.logger.logUser(userText);
    this.history.push({ role: 'user', content: userText });

    let finalText = '';
    const usage = { inp: 0, out: 0, cr: 0, cw: 0 };

    while (true) {
      const response = await this._callApi();
      const turnUsage = this.logger.logAssistant(response);
      for (const k of Object.keys(usage)) usage[k] += turnUsage[k] || 0;

      const textParts = [];
      const toolCalls = [];
      for (const block of (response.content || [])) {
        const t = block.type;
        if (t === 'text')      textParts.push(block.text);
        else if (t === 'tool_use') toolCalls.push(block);
      }
      if (textParts.length) {
        finalText = textParts.join('\n');
        if (onText) onText(finalText);
      }
      this.history.push({ role: 'assistant', content: response.content });

      if (toolCalls.length && this.useTools) {
        const toolResults = [];
        for (const tc of toolCalls) {
          if (onToolUse) onToolUse(tc.name, tc.input);
          const output = await executeTool(tc.name, tc.input);
          if (onToolResult) onToolResult(tc.name, output);
          toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: output });
        }
        this.logger.logToolResults(toolResults);
        this.history.push({ role: 'user', content: toolResults });
      } else {
        break;
      }
    }

    this.logger.logLastPrompt(userText);
    if (this.showCost && (usage.inp + usage.out) > 0) {
      const { estimateCost } = await import('./pricing.js');
      const [actual, noCache] = estimateCost(this.model, usage);
      const crPct = 100 * usage.cr / Math.max(usage.inp + usage.cr, 1);
      console.log(`  💰 Turn cost: $${actual.toFixed(4)} (saved $${(noCache - actual).toFixed(4)} via ${crPct.toFixed(0)}% cache hit)`);
    }
    return { text: finalText, usage };
  }
}
