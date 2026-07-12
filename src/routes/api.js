// src/routes/api.js
// JSON API endpoints. Filterable by ?source= and ?period= (today|week|month|all).

import express from 'express';
import { rateFor, eventCost, sessionCost } from '../pricing.js';

const VALID_SOURCES = new Set(['claude', 'gemini', 'antigravity', 'chatgpt', 'codex', 'puku']);

export function bounds(p) {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let from;
  if (p === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (p === 'week')  { const d = (now.getDay() + 6) % 7; from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d); }
  else if (p === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
  else from = new Date(0);
  return { from, to };
}

export function filteredEvents(state, p, s) {
  const { from, to } = bounds(p);
  return state.events.filter(e => {
    if (s !== 'all' && e.source !== s) return false;
    if (!e.ts) return p === 'all';
    const d = new Date(e.ts);
    return d >= from && d < to;
  });
}

export function filteredSessions(state, evts, s) {
  const ids = new Set(evts.map(e => e.sid));
  return state.sessions.filter(x => ids.has(x.id) && (s === 'all' || x.source === s));
}

function agg(events, sessions) {
  const tC = {}, mC = {}, eC = {}, pC = {}, hC = {}, dC = {}, wC = {}, sC = {}, costM = {}, dCost = {};
  let uM = 0, aM = 0, tCl = 0, tk = 0, oV = 0, iT = 0, oT = 0, cr = 0, cw = 0, tLen = 0, lN = 0, cost = 0, costNC = 0;
  const aD = new Set();

  for (const e of events) {
    const d = e.ts ? new Date(e.ts) : null;
    const ds = d ? d.toISOString().slice(0, 10) : null;
    const h = d ? d.getHours() : null;
    const wd = d ? (d.getDay() + 6) % 7 : null;
    if (ds) { aD.add(ds); dC[ds] = (dC[ds] || 0) + 1; }
    if (h != null) hC[h] = (hC[h] || 0) + 1;
    if (wd != null) wC[wd] = (wC[wd] || 0) + 1;
    sC[e.source] = (sC[e.source] || 0) + 1;

    if (e.t === 'user') {
      uM++; tLen += (e.len || 0); lN++;
      if (e.cwd) pC[e.cwd] = (pC[e.cwd] || 0) + 1;
      if (e.ep)  eC[e.ep]  = (eC[e.ep]  || 0) + 1;
    }
    if (e.t === 'assistant') {
      aM++; oV += (e.out || 0); iT += (e.inp || 0);
      oT += (e.out && e.source === 'claude') ? e.out : 0;
      cr += (e.cr || 0); cw += (e.cw || 0);
      tk += (e.thinking || 0);
      if (e.model) mC[e.model] = (mC[e.model] || 0) + 1;
      for (const t of (e.tools || [])) { tC[t] = (tC[t] || 0) + 1; tCl++; }

      const r = rateFor(e.model);
      if (e.source === 'claude' && r) {
        const c = eventCost(e);
        const allIn = (e.inp || 0) + (e.cr || 0) + (e.cw || 0);
        const nc = (allIn * r.input + (e.out || 0) * r.output) / 1e6;
        cost += c; costNC += nc;
        if (ds) dCost[ds] = (dCost[ds] || 0) + c;
        const m = e.model || 'unknown';
        const cm = costM[m] || (costM[m] = { model: m, inp: 0, out: 0, cr: 0, cw: 0, cost: 0 });
        cm.inp  += (e.inp || 0);
        cm.out  += (e.out || 0);
        cm.cr   += (e.cr  || 0);
        cm.cw   += (e.cw  || 0);
        cm.cost += c;
      }
    }
  }

  const top = (o, n = 20) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const allInput = iT + cr + cw;
  return {
    uM, aM, tCl, tk, oV, iT, oT, cr, cw,
    cH: allInput ? Math.round(100 * cr / allInput) : 0,
    cost, costNC, saved: costNC - cost,
    costM: Object.values(costM).sort((a, b) => b.cost - a.cost),
    dCost,
    tC, mC, eC, pC, hC, dC, wC, sC,
    aD: aD.size,
    avgL: lN ? Math.round(tLen / lN) : 0,
    topT: top(tC),
    topM: top(mC, 12),
    topE: top(eC, 8),
    topP: top(pC, 15),
    topS: top(sC),
    sN: sessions.length,
    pN: Object.keys(pC).length,
  };
}

function getFilter(req) {
  const s = (req.query.source || 'all');
  const p = (req.query.period || 'all');
  return {
    source: VALID_SOURCES.has(s) ? s : 'all',
    period: ['today', 'week', 'month', 'all'].includes(p) ? p : 'all',
  };
}

export function apiRouter(getState, broadcast) {
  const router = express.Router();

  router.get('/scan', (req, res) => {
    const state = getState();
    // state.scan is { sources: { claude: {...}, ... } }
    res.json({ ...state.scan, generatedAt: state.generatedAt });
  });

  router.get('/kpis', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts  = filteredEvents(state, period, source);
    const sess  = filteredSessions(state, evts, source);
    const ag    = agg(evts, sess);
    const totalMem = Object.values(state.memory || {}).reduce((acc, v) => acc + (v?.length || 0), 0);
    res.json({
      source, period,
      sessions: ag.sN,
      userMsgs: ag.uM,
      aiMsgs: ag.aM,
      toolCalls: ag.tCl,
      uniqueTools: Object.keys(ag.tC).length,
      outputVolume: ag.oV,
      thinking: ag.tk,
      activeDays: ag.aD,
      projects: ag.pN,
      inputTokens: ag.iT,
      outputTokens: ag.oT,
      cacheRead: ag.cr,
      cacheWrite: ag.cw,
      cacheHitRate: ag.cH,
      avgMsgLength: ag.avgL,
      memoryFiles: totalMem,
      generatedAt: state.generatedAt,
    });
  });

  router.get('/sessions', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const limit = Math.min(parseInt(req.query.limit) || 400, 5000);
    const offset = parseInt(req.query.offset) || 0;
    const evts = filteredEvents(state, period, source);
    let sess = filteredSessions(state, evts, source);
    sess = sess
      .filter(s => s.start_ts)
      .sort((a, b) => (b.start_ts || '').localeCompare(a.start_ts || ''))
      .slice(offset, offset + limit)
      .map(s => ({
        id: s.id,
        source: s.source,
        start_ts: s.start_ts,
        end_ts: s.end_ts,
        user_turns: s.user_turns || 0,
        assistant_turns: s.assistant_turns || 0,
        input_tokens: s.input_tokens || 0,
        output_tokens: s.output_tokens || 0,
        cache_read: s.cache_read || 0,
        cache_create: s.cache_create || 0,
        thinking_count: s.thinking_count || 0,
        cwd: s.cwd || '',
        models: s.models || [],
        first_message: s.first_message || '',
        title: s.title || '',
        entrypoint: s.entrypoint || '',
        tools_used: s.tools_used || {},
        cost: sessionCost(s),
        duration_s: (s.start_ts && s.end_ts) ? (new Date(s.end_ts) - new Date(s.start_ts)) / 1000 : null,
      }));
    res.json({ source, period, total: sess.length, sessions: sess });
  });

  router.get('/sessions/:id', (req, res) => {
    const state = getState();
    const sess = state.sessions.find(s => s.id === req.params.id);
    if (!sess) return res.status(404).json({ error: 'not found' });
    const turns = state.events
      .filter(e => e.sid === req.params.id)
      .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    res.json({ session: sess, turns, cost: sessionCost(sess) });
  });

  router.get('/events', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts = filteredEvents(state, period, source);
    res.json({ source, period, total: evts.length, events: evts });
  });

  router.get('/cost', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts = filteredEvents(state, period, source);
    const sess = filteredSessions(state, evts, source);
    const ag = agg(evts, sess);
    res.json({
      source, period,
      total: ag.cost,
      saved: ag.saved,
      noCache: ag.costNC,
      cacheHitRate: ag.cH,
      cacheRead: ag.cr,
      cacheWrite: ag.cw,
      byModel: ag.costM,
      daily: ag.dCost,
    });
  });

  router.get('/projects', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts = filteredEvents(state, period, source);
    const sess = filteredSessions(state, evts, source);
    const byProj = {};
    for (const s of sess) {
      const cwd = s.cwd || '(unknown)';
      if (!byProj[cwd]) byProj[cwd] = { cwd, msgs: 0, sessions: 0, last: '' };
      byProj[cwd].sessions++;
      byProj[cwd].msgs += (s.user_turns || 0) + (s.assistant_turns || 0);
      const ts = s.end_ts || s.start_ts || '';
      if (ts > byProj[cwd].last) byProj[cwd].last = ts;
    }
    const rows = Object.values(byProj).sort((a, b) => b.last.localeCompare(a.last));
    res.json({ source, period, projects: rows });
  });

  router.get('/memory', (req, res) => {
    const state = getState();
    res.json(state.memory || {});
  });

  router.get('/settings', (req, res) => {
    const state = getState();
    // truncate to 3000 chars (matches the Python)
    const out = (state.settings || []).map(s => ({
      file: s.file,
      data: JSON.parse(JSON.stringify(s.data, (k, v) => typeof v === 'string' && v.length > 500 ? v.slice(0, 500) : v)),
      truncated: JSON.stringify(s.data).length > 3000,
    }));
    res.json({ settings: out });
  });

  router.get('/top', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts = filteredEvents(state, period, source);
    const sess = filteredSessions(state, evts, source);
    const ag = agg(evts, sess);
    res.json({
      source, period,
      tools: ag.topT,
      models: ag.topM,
      entrypoints: ag.topE,
      projects: ag.topP,
      sources: ag.topS,
    });
  });

  router.get('/activity', (req, res) => {
    const state = getState();
    const { source, period } = getFilter(req);
    const evts = filteredEvents(state, period, source);
    const sess = filteredSessions(state, evts, source);
    const ag = agg(evts, sess);
    res.json({
      source, period,
      daily: ag.dC,
      hourly: ag.hC,
      weekday: ag.wC,
      activeDays: ag.aD,
    });
  });

  // Server-Sent Events stream: pushes { type: "update" } when state changes
  router.get('/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`retry: 3000\n\n`);
    const send = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        // Force flush — express's res doesn't always flush SSE frames immediately
        if (typeof res.flush === 'function') res.flush();
      } catch {}
    };
    send({ type: 'ready', generatedAt: getState().generatedAt });
    const off = broadcast.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); off(); });
  });

  return router;
}

export function createBroadcaster() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(payload) { for (const fn of subs) { try { fn(payload); } catch {} } },
  };
}
