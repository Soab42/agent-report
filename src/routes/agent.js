// src/routes/agent.js
// POST /api/agent and POST /api/agent/stream — runs MyAgent interactively.

import express from 'express';
import { Agent } from '../agent/myagent.js';

export function agentRouter(broadcast) {
  const router = express.Router();

  router.post('/agent', express.json({ limit: '1mb' }), async (req, res) => {
    const { task, model, useTools = true } = req.body || {};
    if (!task) return res.status(400).json({ error: 'task required' });
    try {
      const agent = new Agent({ model, useTools, showCost: false });
      const result = await agent.send(task);
      res.json({
        text: result.text,
        usage: result.usage,
        sessionId: agent.sessionId,
        logPath: agent.logger.path,
      });
      // notify watchers: a new session has been written to disk
      broadcast.emit({ type: 'update', source: 'puku' });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  router.post('/agent/stream', express.json({ limit: '1mb' }), async (req, res) => {
    const { task, model, useTools = true } = req.body || {};
    if (!task) return res.status(400).end('task required');
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders?.();
    const send = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    try {
      const agent = new Agent({ model, useTools, showCost: false });
      const result = await agent.send(task, {
        onText: (text) => send('text', { delta: text }),
        onToolUse: (name, input) => send('tool', { name, input }),
        onToolResult: (name, output) => send('tool_result', { name, output }),
      });
      send('done', { text: result.text, usage: result.usage, sessionId: agent.sessionId, logPath: agent.logger.path });
      broadcast.emit({ type: 'update', source: 'puku' });
    } catch (e) {
      send('error', { message: String(e?.message || e) });
    } finally {
      res.end();
    }
  });

  return router;
}
