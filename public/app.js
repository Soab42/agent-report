// public/app.js
// Dashboard client. Fetches JSON from /api/* and renders charts/tables.
// Two modes:
//   - live server mode: fetches /api/scan, /api/events, /api/sessions, etc.
//   - snapshot mode (SNAPSHOT=true): reads SNAPSHOT_STATE baked into the page

const SNAPSHOT       = (typeof window.SNAPSHOT !== 'undefined') && window.SNAPSHOT === true;
const SNAPSHOT_STATE = window.SNAPSHOT_STATE || null;
const SNAPSHOT_COLORS = window.SNAPSHOT_COLORS || null;
const SNAPSHOT_LABELS = window.SNAPSHOT_LABELS || null;

let ALL_EVENTS = [];
let ALL_SESSIONS = [];
let SCAN_INFO = {};
let MEMORY = {};
let SETTINGS = [];
let SRC_COLORS = SNAPSHOT_COLORS || {};
let SRC_LABELS = SNAPSHOT_LABELS || {};
let GENERATED_AT = '—';
let TOTAL_EV = 0;

let curP = 'all', curS = 'all';

// ── helpers ──────────────────────────────────────────────────────────────
function bounds(p) {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let from;
  if (p === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (p === 'week') { const d = (now.getDay() + 6) % 7; from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d); }
  else if (p === 'month') from = new Date(now.getFullYear(), now.getMonth(), 1);
  else from = new Date(0);
  return { from, to };
}

function filteredEvts(p, s) {
  const { from, to } = bounds(p);
  return ALL_EVENTS.filter(e => {
    if (s !== 'all' && e.source !== s) return false;
    if (!e.ts) return p === 'all';
    const d = new Date(e.ts);
    return d >= from && d < to;
  });
}

function filteredSess(evts, s) {
  const ids = new Set(evts.map(e => e.sid));
  return ALL_SESSIONS.filter(x => ids.has(x.id) && (s === 'all' || x.source === s));
}

// ── aggregation (mirrors Python's agg() in build_html) ──────────────────
function agg(evts, sess) {
  const tC = {}, mC = {}, eC = {}, pC = {}, hC = {}, dC = {}, wC = {}, sC = {}, costM = {}, dCost = {};
  let uM = 0, aM = 0, tCl = 0, tk = 0, oV = 0, iT = 0, oT = 0, cr = 0, cw = 0, tLen = 0, lN = 0, cost = 0, costNC = 0;
  const aD = new Set();

  for (const e of evts) {
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
    sN: sess.length,
    pN: Object.keys(pC).length,
  };
}

// ── pricing (mirrors src/pricing.js RATES) ───────────────────────────────
const RATES = {
  'claude-fable-5':    { input: 10,  output: 50, cr: 1.00, cw: 12.50 },
  'claude-opus-4-8':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-7':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-6':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-5':   { input:  5,  output: 25, cr: 0.50, cw:  6.25 },
  'claude-opus-4-1':   { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-opus-4':     { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-opus-3':     { input: 15,  output: 75, cr: 1.50, cw: 18.75 },
  'claude-sonnet-4-6': { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-sonnet-4-5': { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-sonnet-4':   { input:  3,  output: 15, cr: 0.30, cw:  3.75 },
  'claude-haiku-4-5':  { input:  1,  output:  5, cr: 0.10, cw:  1.25 },
  'claude-3-5-haiku':  { input:  0.8, output: 4, cr: 0.08, cw: 1.00 },
  'claude-3-haiku':    { input:  0.25, output: 1.25, cr: 0.03, cw: 0.30 },
};
const DEFAULT_RATE = RATES['claude-opus-4-8'];
function rateFor(model) {
  if (!model) return null;
  const id = String(model).replace(/^(anthropic|us|eu|apac)\./, '');
  for (const k of Object.keys(RATES)) if (id.startsWith(k)) return RATES[k];
  return id.startsWith('claude-') ? DEFAULT_RATE : null;
}
function eventCost(e) {
  if (e.source !== 'claude') return 0;
  const r = rateFor(e.model);
  if (!r) return 0;
  return ((e.inp || 0) * r.input + (e.out || 0) * r.output + (e.cr || 0) * r.cr + (e.cw || 0) * r.cw) / 1e6;
}
function sessCost(s) {
  if (s.source !== 'claude') return null;
  const m = (s.models && s.models[0]) || '';
  const r = rateFor(m);
  if (!r) return null;
  return (((s.input_tokens || 0) * r.input + (s.output_tokens || 0) * r.output +
           (s.cache_read || 0) * r.cr + (s.cache_create || 0) * r.cw)) / 1e6;
}

// ── charts ───────────────────────────────────────────────────────────────
Chart.defaults.color = '#8890b0';
Chart.defaults.borderColor = '#2e3250';
const CH = {};
function dk(id) { if (CH[id]) { CH[id].destroy(); delete CH[id]; } }
const PAL = ['#6c63ff', '#1a73e8', '#00c4b4', '#10a37f', '#f97316', '#ff6584', '#ffd700', '#43e97b', '#38f9d7', '#f093fb', '#a8edea', '#fed6e3'];

// ── format ───────────────────────────────────────────────────────────────
function fmt(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'; return String(Math.round(n)); }
function fmtD(s) { if (!s || s < 0) return '—'; if (s < 60) return s.toFixed(0) + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's'; return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; }
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function shortenPath(p, n = 55) {
  if (!p) return '';
  if (p.length <= n) return p;
  const parts = p.split('/').filter(Boolean);
  return parts.length >= 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// ── render pipeline ──────────────────────────────────────────────────────
function render(p, s) {
  const evts = filteredEvts(p, s);
  const sess = filteredSess(evts, s);
  const ag = agg(evts, sess);

  // Period label
  const { from, to } = bounds(p);
  const fd = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const days = Object.keys(ag.dC).sort();
  document.getElementById('pr').textContent =
    p === 'all' ? (days.length ? days[0] + ' → ' + days.slice(-1)[0] : '') : fd(from) + ' → ' + fd(new Date(to - 1));

  // KPIs
  const kv = [ag.sN, ag.uM, ag.aM, ag.tCl, ag.oV, ag.tk, ag.aD, ag.pN, ag.iT, ag.oT, ag.avgL, totalMemory()];
  ['k0','k1','k2','k3','k4','k5','k6','k7','k8','k9','k10','k11'].forEach((id, i) => {
    document.getElementById(id).textContent = fmt(kv[i]);
  });
  document.getElementById('k3s').textContent = Object.keys(ag.tC).length + ' unique tools';
  document.getElementById('k8s').textContent = 'cache hit: ' + ag.cH + '%';

  // Source chips
  document.getElementById('chips').innerHTML = ag.topS.map(([src, cnt]) => {
    const c = SRC_COLORS[src] || '#888';
    const l = SRC_LABELS[src] || src;
    return `<div class="chip" style="color:${c};border-color:${c};background:${c}22">
      <span>${l}</span><span style="font-weight:400">${fmt(cnt)} events</span></div>`;
  }).join('');

  // Timeline
  const dl = Object.entries(ag.dC).sort((a, b) => a[0] < b[0] ? -1 : 1);
  dk('tl');
  if (dl.length) CH['tl'] = new Chart(document.getElementById('ch-tl'), {
    type: 'line',
    data: { labels: dl.map(d => d[0]), datasets: [{ label: 'Events', data: dl.map(d => d[1]),
      borderColor: '#6c63ff', backgroundColor: 'rgba(108,99,255,.15)', fill: true, tension: .4, pointRadius: 2 }] },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { x: { grid: { color: '#2e3250' }, ticks: { maxTicksLimit: 14, font: { size: 10 } } },
               y: { grid: { color: '#2e3250' }, beginAtZero: true } } }
  });

  // Hourly heatmap
  const hm = document.getElementById('hm'); hm.innerHTML = '';
  const mxH = Math.max(...Array.from({ length: 24 }, (_, h) => ag.hC[h] || 0), 1);
  for (let h = 0; h < 24; h++) {
    const v = ag.hC[h] || 0, ix = v / mxH;
    const c = document.createElement('div'); c.className = 'hmc'; c.title = h + ':00 — ' + v; c.textContent = h;
    if (v > 0) {
      c.style.background = `rgba(${108 + Math.round(ix * 147)},${99 - Math.round(ix * 99)},${255 - Math.round(ix * 255)},${.35 + ix * .65})`;
      c.style.color = ix > .5 ? '#fff' : '';
    }
    hm.appendChild(c);
  }

  // Weekday
  dk('wd');
  CH['wd'] = new Chart(document.getElementById('ch-wd'), {
    type: 'bar',
    data: { labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
      datasets: [{ label: 'Events',
        data: [0,1,2,3,4,5,6].map(i => ag.wC[i] || 0),
        backgroundColor: ['#6c63ff','#6c63ff','#6c63ff','#6c63ff','#6c63ff','#ff6584','#ff6584'].map(c => c + 'bb'),
        borderRadius: 4 }] },
    options: { responsive: true, plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: '#2e3250' }, beginAtZero: true } } }
  });

  // Source donut
  dk('src');
  if (ag.topS.length) CH['src'] = new Chart(document.getElementById('ch-src'), {
    type: 'doughnut',
    data: { labels: ag.topS.map(s => SRC_LABELS[s[0]] || s[0]),
      datasets: [{ data: ag.topS.map(s => s[1]),
        backgroundColor: ag.topS.map(s => SRC_COLORS[s[0]] || '#888'), borderWidth: 0 }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } }
  });

  // Top dirs (overview)
  document.getElementById('proj-body').innerHTML = ag.topP.length
    ? ag.topP.map(([p, c]) => `<tr><td class="trunc" title="${escHtml(p)}">${escHtml(shortenPath(p, 55))}</td><td>${c}</td></tr>`).join('')
    : '<tr><td colspan="2" class="nd">No directory data</td></tr>';

  // Projects tab
  renderProjects(evts, sess);
  closeSessDetail();

  // Tools
  dk('tools');
  if (ag.topT.length) CH['tools'] = new Chart(document.getElementById('ch-tools'), {
    type: 'bar',
    data: { labels: ag.topT.map(t => String(t[0]).replace('mcp__', '')),
      datasets: [{ label: 'Calls', data: ag.topT.map(t => t[1]), backgroundColor: 'rgba(67,233,123,.7)', borderRadius: 3 }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } },
      scales: { x: { grid: { color: '#2e3250' }, beginAtZero: true }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } } }
  });

  // Models
  dk('models');
  if (ag.topM.length) CH['models'] = new Chart(document.getElementById('ch-models'), {
    type: 'doughnut',
    data: { labels: ag.topM.map(m => m[0]),
      datasets: [{ data: ag.topM.map(m => m[1]), backgroundColor: PAL, borderWidth: 0 }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { size: 10 } } } } }
  });

  // Cost tab
  document.getElementById('c0').textContent = '$' + ag.cost.toFixed(2);
  document.getElementById('c1').textContent = '$' + ag.saved.toFixed(2);
  document.getElementById('c1s').textContent = ag.costNC > 0 ? Math.round(100 * ag.saved / ag.costNC) + '% cheaper' : 'vs no cache';
  document.getElementById('c2').textContent = '$' + ag.costNC.toFixed(2);
  document.getElementById('c3').textContent = ag.cH + '%';
  document.getElementById('c4').textContent = fmt(ag.cr);
  document.getElementById('c5').textContent = fmt(ag.cw);

  const dcl = Object.entries(ag.dCost).sort((a, b) => a[0] < b[0] ? -1 : 1);
  dk('dcost');
  if (dcl.length) CH['dcost'] = new Chart(document.getElementById('ch-dcost'), {
    type: 'bar',
    data: { labels: dcl.map(d => d[0]), datasets: [{ label: 'USD', data: dcl.map(d => +d[1].toFixed(4)),
      backgroundColor: 'rgba(255,215,0,.7)', borderRadius: 3 }] },
    options: { responsive: true, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: c => '$' + (+c.parsed.y).toFixed(2) } } },
      scales: { x: { grid: { color: '#2e3250' }, ticks: { maxTicksLimit: 14, font: { size: 10 } } },
               y: { grid: { color: '#2e3250' }, beginAtZero: true, ticks: { callback: v => '$' + v } } } }
  });

  dk('mcost');
  if (ag.costM.length) CH['mcost'] = new Chart(document.getElementById('ch-mcost'), {
    type: 'doughnut',
    data: { labels: ag.costM.map(m => m.model),
      datasets: [{ data: ag.costM.map(m => +m.cost.toFixed(4)), backgroundColor: PAL, borderWidth: 0 }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { size: 10 } } },
      tooltip: { callbacks: { label: c => c.label + ': $' + (+c.parsed).toFixed(2) } } } }
  });

  document.getElementById('mcost-body').innerHTML = ag.costM.length
    ? ag.costM.map(m => `<tr><td class="trunc" title="${escHtml(m.model)}">${escHtml(m.model)}</td>
        <td>${fmt(m.inp)}</td><td>${fmt(m.out)}</td><td>${fmt(m.cr)}</td><td>${fmt(m.cw)}</td>
        <td style="color:var(--gold);font-weight:600">$${m.cost.toFixed(2)}</td></tr>`).join('')
      + `<tr style="border-top:2px solid var(--bd)"><td><b>Total</b></td><td></td><td></td><td></td><td></td>
         <td style="color:var(--gold);font-weight:700">$${ag.cost.toFixed(2)}</td></tr>`
    : '<tr><td colspan="6" class="nd">No Claude token usage in this period / source</td></tr>';

  // Entrypoints
  dk('ep');
  if (ag.topE.length) CH['ep'] = new Chart(document.getElementById('ch-ep'), {
    type: 'pie',
    data: { labels: ag.topE.map(e => e[0]),
      datasets: [{ data: ag.topE.map(e => e[1]), backgroundColor: PAL, borderWidth: 0 }] },
    options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { size: 10 } } } } }
  });

  // Tools table
  document.getElementById('tools-body').innerHTML =
    Object.entries(ag.tC).sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `<tr><td>${escHtml(t)}</td><td>${c}</td></tr>`).join('')
    || '<tr><td colspan="2" class="nd">No tool calls</td></tr>';

  // Sessions table
  const sr = sess.filter(s => s.start_ts)
    .sort((a, b) => (b.start_ts || '').localeCompare(a.start_ts || ''))
    .slice(0, 400);
  document.getElementById('sess-body').innerHTML = sr.map(s => {
    const col = SRC_COLORS[s.source] || '#888';
    const lbl = SRC_LABELS[s.source] || s.source || '?';
    const start = (s.start_ts || '').slice(0, 16).replace('T', ' ');
    const dur = (s.start_ts && s.end_ts) ? fmtD((new Date(s.end_ts) - new Date(s.start_ts)) / 1000) : '—';
    const vol = fmt((s.input_tokens || 0) + (s.output_tokens || 0));
    const topic = ((s.first_message || s.title || '—')).replace(/</g, '&lt;').slice(0, 80);
    const cwd = s.cwd || '—';
    const cwdS = cwd.length > 45 ? '…/' + cwd.split('/').slice(-2).join('/') : cwd;
    const model = (s.models || []).slice(0, 2).join(', ') || '—';
    return `<tr>
      <td><span class="badge" style="background:${col}">${lbl}</span></td>
      <td style="white-space:nowrap;font-size:10px">${start}</td>
      <td class="trunc" title="${escHtml(topic)}">${topic}</td>
      <td>${s.user_turns || 0}/${s.assistant_turns || 0}</td>
      <td>${vol}</td><td>${dur}</td>
      <td style="font-size:10px" class="trunc">${escHtml(model)}</td>
      <td class="trunc" title="${escHtml(cwd)}">${escHtml(cwdS)}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="nd">No sessions in this period / source</td></tr>';

  filterTbl();
}

function totalMemory() {
  return Object.values(MEMORY || {}).reduce((acc, v) => acc + (v?.length || 0), 0);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtTok(n) { if (!n) return '—'; return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n); }

function renderProjects(evts, sess) {
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
  const name = p => p.split('/').filter(Boolean).pop() || p;
  document.getElementById('projects-body').innerHTML = rows.map(p =>
    `<tr class="proj-row" data-cwd="${escHtml(p.cwd)}" onclick="loadProjectSessions(this,'${escHtml(p.cwd)}')">
      <td title="${escHtml(p.cwd)}"><span class="project-badge">${escHtml(name(p.cwd))}</span></td>
      <td>${p.msgs}</td>
      <td>${p.sessions}</td>
      <td style="white-space:nowrap">${fmtDate(p.last)}</td>
    </tr>`
  ).join('') || '<tr><td colspan="4" class="nd">No projects in this period</td></tr>';
}

function loadProjectSessions(rowEl, cwd) {
  document.querySelectorAll('.proj-row').forEach(r => r.classList.remove('active-row'));
  rowEl.classList.add('active-row');
  const evts = filteredEvts(curP, curS);
  const sess = filteredSess(evts, curS).filter(s => s.cwd === cwd);
  const sorted = sess.sort((a, b) => (b.start_ts || '').localeCompare(a.start_ts || ''));
  const name = cwd.split('/').filter(Boolean).pop() || cwd;
  document.getElementById('sess-detail-title').textContent = 'Sessions — ' + name;
  document.getElementById('sess-detail-body').innerHTML = sorted.map(s => {
    const title = ((s.first_message || s.title || '—')).replace(/</g, '&lt;').slice(0, 80);
    const cost = sessCost(s);
    const costStr = cost != null ? '$' + cost.toFixed(2) : '—';
    const msgs = (s.user_turns || 0) + (s.assistant_turns || 0);
    return `<tr>
      <td class="prompt-text" title="${escHtml(s.first_message || s.title || '')}">${title}</td>
      <td>${msgs}</td>
      <td>${fmtTok(s.input_tokens)}</td>
      <td>${fmtTok(s.output_tokens)}</td>
      <td>${costStr}</td>
      <td style="white-space:nowrap">${fmtDate(s.start_ts)}</td>
      <td style="white-space:nowrap">${fmtDate(s.end_ts)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="nd">No sessions found</td></tr>';
  document.getElementById('pj-right').classList.add('open');
}

function closeSessDetail() {
  document.getElementById('pj-right').classList.remove('open');
  document.querySelectorAll('.proj-row').forEach(r => r.classList.remove('active-row'));
}

function filterProj() {
  const q = document.getElementById('pf').value.toLowerCase();
  document.querySelectorAll('#projects-body tr').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function filterTbl() {
  const q = document.getElementById('ss').value.toLowerCase();
  document.querySelectorAll('#sess-body tr').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ── tab controls ─────────────────────────────────────────────────────────
function setPeriod(p, btn) {
  curP = p;
  document.querySelectorAll('.pb').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  render(curP, curS);
}
function setSrc(s, btn) {
  curS = s;
  document.querySelectorAll('.src-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  render(curP, curS);
}
function showTab(n, btn) {
  document.querySelectorAll('.tp').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tb').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + n).classList.add('active');
  if (btn) btn.classList.add('active');
}

// ── memory / settings / scan panels ──────────────────────────────────────
function renderStaticPanels() {
  // Memory
  let memHtml = '';
  const types = ['user', 'feedback', 'project', 'reference'];
  for (const t of types) {
    const entries = MEMORY[t] || [];
    if (!entries.length) continue;
    const rows = entries.map(e => `<tr><td><b>${escHtml(e.name)}</b></td><td>${escHtml(e.description)}</td></tr>`).join('');
    memHtml += `<div class="msec"><h4 class="mtype">${t.toUpperCase()} (${entries.length})</h4>
      <table class="dt"><thead><tr><th>Name</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }
  document.getElementById('mem-body').innerHTML = memHtml || '<p class="nd">No memory files found.</p>';

  // Settings
  const settingsHtml = (SETTINGS || []).map(s => {
    const json = JSON.stringify(s.data, null, 2);
    const truncated = json.length > 3000 ? json.slice(0, 3000) + '\n...[truncated]' : json;
    return `<p class="sf">${escHtml(s.file)}</p><pre class="sp"><code>${escHtml(truncated)}</code></pre>`;
  }).join('') || '<p class="nd">No settings files found.</p>';
  document.getElementById('settings-body').innerHTML = settingsHtml;

  // Scan summary
  const scanRows = Object.entries(SCAN_INFO).map(([src, info]) => {
    const col = SRC_COLORS[src] || '#888';
    const lbl = SRC_LABELS[src] || src;
    return `<tr><td><span class="badge" style="background:${col}">${lbl}</span></td>
      <td>${fmt(info.events)} events &nbsp; ${fmt(info.sessions)} sessions</td>
      <td class="trunc" title="${escHtml(info.path || '')}">${escHtml(shortenPath(info.path || '', 60))}</td></tr>`;
  }).join('');
  document.getElementById('scan-body').innerHTML = scanRows || '<tr><td colspan="3" class="nd">No scan data</td></tr>';
}

// ── header meta + source buttons ─────────────────────────────────────────
function renderMeta() {
  document.getElementById('gen-ts').textContent = (GENERATED_AT || '—').replace('T', ' ').slice(0, 19);
  document.getElementById('gen-ev').textContent = fmt(TOTAL_EV);

  const sourcesPresent = [...new Set(ALL_EVENTS.map(e => e.source).filter(Boolean))].sort();
  document.getElementById('src-btns').innerHTML = sourcesPresent.map(s =>
    `<button class="src-btn" data-src="${s}" onclick="setSrc('${s}',this)" style="--sc:${SRC_COLORS[s] || '#888'}">${SRC_LABELS[s] || s}</button>`
  ).join('');
}

// ── bootstrap & live updates ─────────────────────────────────────────────
async function loadAll() {
  if (SNAPSHOT) {
    const st = SNAPSHOT_STATE;
    ALL_EVENTS = st.events;
    ALL_SESSIONS = st.sessions;
    SCAN_INFO = st.scan.sources || {};
    MEMORY = st.memory || {};
    SETTINGS = st.settings || [];
    GENERATED_AT = st.generatedAt;
    TOTAL_EV = ALL_EVENTS.length;
    document.title = 'AI Tools Analyzer (snapshot)';
  } else {
    const [scanR, sessR, eventsR, memR, setR] = await Promise.all([
      fetch('/api/scan').then(r => r.json()),
      fetch('/api/sessions?limit=5000').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
      fetch('/api/memory').then(r => r.json()),
      fetch('/api/settings').then(r => r.json()),
    ]);
    SCAN_INFO = scanR.sources || {};
    GENERATED_AT = scanR.generatedAt;
    ALL_SESSIONS = sessR.sessions || [];
    ALL_EVENTS = eventsR.events || [];
    MEMORY = memR || {};
    SETTINGS = (setR.settings || []).map(s => ({ file: s.file, data: s.data }));
    TOTAL_EV = ALL_EVENTS.length;
  }
  renderMeta();
  renderStaticPanels();
  render('all', 'all');
  document.getElementById('boot').classList.add('hidden');
  document.getElementById('app').style.display = '';
}

async function refreshAll() {
  if (SNAPSHOT) return;             // snapshot is static
  try {
    const [scanR, sessR, eventsR] = await Promise.all([
      fetch('/api/scan').then(r => r.json()),
      fetch('/api/sessions?limit=5000').then(r => r.json()),
      fetch('/api/events').then(r => r.json()),
    ]);
    SCAN_INFO = scanR.sources || {};
    GENERATED_AT = scanR.generatedAt;
    ALL_SESSIONS = sessR.sessions || [];
    ALL_EVENTS = eventsR.events || [];
    TOTAL_EV = ALL_EVENTS.length;
    renderMeta();
    render(curP, curS);
    flashLive();
  } catch (e) {
    console.warn('Refresh failed', e);
  }
}

function flashLive() {
  const pill = document.getElementById('live-pill');
  pill.classList.remove('off');
  pill.textContent = 'LIVE';
  clearTimeout(flashLive._t);
  flashLive._t = setTimeout(() => { pill.textContent = 'LIVE'; }, 1200);
}

// SSE listener
function connectStream() {
  if (SNAPSHOT) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('data', (msg) => {
    try {
      const payload = JSON.parse(msg.data);
      if (payload.type === 'update') refreshAll();
    } catch {}
  });
  es.onerror = () => { setTimeout(connectStream, 3000); es.close(); };
}

// ── MyAgent chat panel ───────────────────────────────────────────────────
async function agentSend(ev) {
  ev.preventDefault();
  const input = document.getElementById('agent-input');
  const task = input.value.trim();
  if (!task) return false;
  input.value = '';
  const log = document.getElementById('agent-log');
  log.textContent += `\n> You: ${task}\n`;
  log.scrollTop = log.scrollHeight;

  try {
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const data = await res.json();
    if (data.error) {
      log.textContent += `\n[error: ${data.error}]\n`;
    } else {
      log.textContent += `\nAssistant: ${data.text}\n`;
      log.textContent += `[tokens in=${data.usage?.inp || 0}, out=${data.usage?.out || 0}, cache_read=${data.usage?.cr || 0}]\n`;
    }
  } catch (e) {
    log.textContent += `\n[network error: ${e.message}]\n`;
  }
  log.scrollTop = log.scrollHeight;
  return false;
}
window.agentSend = agentSend;
window.setPeriod = setPeriod;
window.setSrc = setSrc;
window.showTab = showTab;
window.filterTbl = filterTbl;
window.filterProj = filterProj;
window.loadProjectSessions = loadProjectSessions;
window.closeSessDetail = closeSessDetail;

window.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  connectStream();
});
