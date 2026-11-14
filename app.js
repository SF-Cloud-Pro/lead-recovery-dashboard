'use strict';
// Lead Recovery Monitor dashboard. Reads everything from the API (api/*) and refreshes every 60 s; the public copy reads a chosen data file.
// All text is inserted with textContent or DOM nodes, never as HTML strings.

const REFRESH_MS = 60000;
const PAGE = 50;
const OUTCOME_LABEL = { DELIVERED: 'Delivered', RECOVERED: 'Recovered', SKIPPED: 'Skipped', PENDING: 'Pending', FAILED: 'Failed' };
const HEADLINE = { DELIVERED: 'SUCCESSFULLY DELIVERED', RECOVERED: 'RECOVERED', SKIPPED: 'SKIPPED', PENDING: 'PENDING', FAILED: 'FAILED' };

const S = {
  day: null,
  today: null,
  offset: 0,
  searchId: null,
  nextAt: Date.now() + REFRESH_MS,
  busy: false,
  leadsTotal: 0,
  lastLeadsRows: 0,
};

const $ = (id) => document.getElementById(id);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      // The page's CSP blocks style="" attributes; setting each property through the DOM style API is allowed.
      else if (k === 'style') {
        for (const part of String(v).split(';')) {
          const i = part.indexOf(':');
          if (i > 0) node.style.setProperty(part.slice(0, i).trim(), part.slice(i + 1).trim());
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const clear = (node) => {
  node.replaceChildren();
  return node;
};
const n = (v) => Number(v || 0).toLocaleString('en-US');
const pct = (v) => `${(Number(v) || 0).toFixed(1)}%`;
const pkt = (iso) =>
  iso
    ? `${new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} PKT`
    : '—';
const pktClock = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
const badge = (outcome) => el('span', { class: `badge b-${outcome}`, text: OUTCOME_LABEL[outcome] ?? outcome });

// Two modes. On the local server, data comes from api/* over HTTP. On the public GitHub Pages copy there is no
// server (the same paths return 404), so the page answers the same requests from a data file the viewer chooses.
let STATIC = false;
let dataBundle = null;
let apiModule = null;
// The public copy loads data.json (totals only) from the same folder and reloads it every 5 minutes.
let PUBLIC = false;
let lastPublicLoad = 0;
const PUBLIC_NOTICE = 'Public copy: totals only. Lead details and Record ID search are in the private copy.';

async function loadPublicCopy() {
  try {
    const r = await fetch('data.json', { cache: 'no-store' });
    if (!r.ok) return false;
    const bundle = await r.json();
    if (!bundle || bundle.format !== 1 || bundle.public !== true) return false;
    dataBundle = bundle;
    PUBLIC = true;
    lastPublicLoad = Date.now();
    return true;
  } catch {
    return false;
  }
}

async function getJson(url) {
  if (STATIC) return staticGet(url);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: 'The monitor server is not reachable.' } };
  }
}

async function staticGet(url) {
  if (!dataBundle) return { ok: false, status: 0, body: { error: 'No data loaded. Choose your data file above.' } };
  const u = new URL(url, location.href);
  const path = u.pathname.slice(u.pathname.indexOf('/api/'));
  apiModule = apiModule ?? (await import('./lib/api.mjs'));
  const r = apiModule.apiResponse({ path, params: u.searchParams, data: dataBundle, now: new Date() });
  return { ok: r.status < 400, status: r.status, body: r.body };
}

async function detectMode() {
  try {
    const r = await fetch('api/status', { cache: 'no-store' });
    STATIC = r.status === 404;
  } catch {
    STATIC = false; // the local server is down: show that as offline rather than switching modes
  }
  $('loader').hidden = !STATIC;
}

async function loadDataFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    if (!bundle || bundle.format !== 1 || !Array.isArray(bundle.records)) throw new Error('not an export');
    dataBundle = bundle;
    showNotice(`Loaded ${file.name}, exported ${pkt(bundle.generatedAt)}. It stays in this browser tab and was not uploaded.`);
    await refreshAll();
  } catch {
    showNotice('That file is not a monitor data export (dashboard-export.json).');
  }
}

function showNotice(text) {
  const box = $('notice');
  if (!text) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = text;
}

// ---------- live status ----------
function renderLive(st) {
  const box = $('live');
  box.classList.remove('is-live', 'is-stale', 'is-offline');
  const text = $('liveText');
  if (!st) {
    box.classList.add('is-offline');
    text.textContent = STATIC ? 'No data loaded' : 'Monitor offline';
    return;
  }
  if (st.live === 'live') {
    box.classList.add('is-live');
    text.textContent = `Live · checks every ${st.intervalMinutes} min · last check ${pktClock(st.lastCycleAt)}`;
  } else if (st.live === 'stale') {
    box.classList.add('is-stale');
    const why = st.health && st.health !== 'OK' && st.healthReason ? ` · ${st.health}: ${st.healthReason}` : '';
    text.textContent = `Stale · last check ${pkt(st.lastCycleAt)}${why}`;
  } else {
    text.textContent = 'No monitoring data yet. Start the monitor (see README).';
  }
}

// ---------- summary ----------
function renderCards(sm) {
  const t = sm.totals;
  const cards = [
    { label: sm.isToday ? "Today's total leads" : `Leads for ${sm.day}`, value: n(t.total), note: 'unique Record IDs', tone: '' },
    { label: 'Successful deliveries', value: n(t.successful), note: `${pct(t.successRate)} of total`, tone: 'ok' },
    { label: 'Skipped (pending recovery)', value: n(t.skipped), note: `${n(t.skippedAtAny)} skipped at some point`, tone: 'warn' },
    { label: 'Recovered leads', value: n(t.recovered), note: 'skipped, then verified in the sheet', tone: 'info' },
    { label: 'Pending leads', value: n(t.pending), note: 'waiting for their run or window', tone: 'muted' },
    { label: 'Failed leads', value: n(t.failed), note: 'need a person', tone: 'bad' },
    { label: 'Active workflows', value: n(sm.activeWorkflows), note: `${n(sm.runsInProgress)} run(s) in progress`, tone: 'muted' },
  ];
  const root = clear($('cards'));
  for (const c of cards) {
    root.append(
      el('div', { class: `card ${c.tone ? `tone-${c.tone}` : ''}` },
        el('div', { class: 'label', text: c.label }),
        el('div', { class: 'value', text: c.value }),
        el('div', { class: 'note', text: c.note }),
      ),
    );
  }
  const rates = clear($('rates'));
  const failure = t.total ? ((t.skipped + t.failed) / t.total) * 100 : 0;
  rates.append(
    rateBox('Success rate', t.successRate, 'var(--ok)', `${n(t.successful)} of ${n(t.total)} verified in the sheet`),
    rateBox('Failure rate', failure, 'var(--bad)', `${n(t.skipped + t.failed)} skipped or failed and not yet delivered`),
  );
}

function rateBox(title, value, color, note) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return el('div', { class: 'rate' },
    el('div', { class: 'label muted', text: title }),
    el('div', { class: 'big', text: pct(value) }),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${v}%;background:${color}` })),
    el('div', { class: 'muted', text: note, style: 'font-size:12px;margin-top:6px' }),
  );
}

function stack(parts, total) {
  const bar = el('div', { class: 'stack', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.value}`).join(', ') });
  for (const p of parts) {
    if (!p.value || total <= 0) continue;
    bar.append(el('span', { class: p.cls, style: `width:${(p.value / total) * 100}%`, title: `${p.label}: ${p.value}` }));
  }
  return bar;
}

function segments(row) {
  return [
    { cls: 's-ok', label: 'Delivered', value: row.delivered },
    { cls: 's-rec', label: 'Recovered', value: row.recovered },
    { cls: 's-skip', label: 'Skipped', value: row.skipped },
    { cls: 's-fail', label: 'Failed', value: row.failed },
    { cls: 's-pend', label: 'Pending', value: row.pending },
  ];
}

const LEGEND = [
  ['s-ok', 'Delivered'],
  ['s-rec', 'Recovered'],
  ['s-skip', 'Skipped (pending recovery)'],
  ['s-fail', 'Failed (needs a person)'],
  ['s-pend', 'Pending'],
];

function legend() {
  return el('div', { class: 'legend' }, LEGEND.map(([cls, text]) => el('span', {}, el('i', { class: cls }), text)));
}

function renderCategories(sm) {
  const rows = sm.categories;
  const chips = clear($('catChips'));
  chips.append(chipButton('', 'All'));
  for (const r of rows) chips.append(chipButton(r.category, `${r.category} (${n(r.total)})`));

  const bars = clear($('catBars'));
  if (!rows.length) {
    bars.append(el('p', { class: 'muted', text: 'No leads were marked on this day.' }));
  } else {
    const max = Math.max(...rows.map((r) => r.total));
    bars.append(legend());
    for (const r of rows) {
      const shade = el('div', { style: `width:${(r.total / max) * 100}%;min-width:4px` }, stack(segments(r), r.total));
      bars.append(
        el('div', { class: 'catbar' },
          el('button', { type: 'button', onclick: () => setCategory(r.category), title: `Show ${r.category} leads` }, r.category),
          shade,
          el('span', { class: 'count', text: n(r.total) }),
        ),
      );
    }
  }

  const table = clear($('catTable'));
  const headers = ['Category', 'Total', 'Successful', 'Skipped', 'Recovered', 'Failed', 'Pending', 'Success %'];
  table.append(el('thead', {}, el('tr', {}, ...headers.map((h, i) => el('th', { class: i ? 'num' : '', text: h })))));
  const body = el('tbody');
  for (const r of rows) {
    body.append(el('tr', { tabindex: '0', onclick: () => setCategory(r.category), onkeydown: (e) => { if (e.key === 'Enter') setCategory(r.category); } },
      el('td', { text: r.category }),
      el('td', { class: 'num', text: n(r.total) }),
      el('td', { class: 'num', text: n(r.successful) }),
      el('td', { class: 'num', text: n(r.skipped) }),
      el('td', { class: 'num', text: n(r.recovered) }),
      el('td', { class: 'num', text: n(r.failed) }),
      el('td', { class: 'num', text: n(r.pending) }),
      el('td', { class: 'num', text: pct(r.successRate) }),
    ));
  }
  if (rows.length) {
    const t = sm.totals;
    body.append(el('tr', { class: 'is-total' },
      el('td', { text: 'All categories' }),
      el('td', { class: 'num', text: n(t.total) }),
      el('td', { class: 'num', text: n(t.successful) }),
      el('td', { class: 'num', text: n(t.skipped) }),
      el('td', { class: 'num', text: n(t.recovered) }),
      el('td', { class: 'num', text: n(t.failed) }),
      el('td', { class: 'num', text: n(t.pending) }),
      el('td', { class: 'num', text: pct(t.successRate) }),
    ));
  }
  table.append(body);
  syncCategorySelect(rows);
}

function chipButton(value, label) {
  const active = (document.getElementById('fCategory').value || '') === value;
  return el('button', { type: 'button', class: 'chip', 'aria-pressed': active ? 'true' : 'false', onclick: () => setCategory(value) }, label);
}

function setCategory(value) {
  $('fCategory').value = value;
  S.offset = 0;
  refreshLeads();
  renderCategoryChipState();
}

function renderCategoryChipState() {
  const current = $('fCategory').value || '';
  for (const b of $('catChips').querySelectorAll('button.chip')) {
    const label = b.textContent;
    const value = label === 'All' ? '' : label.replace(/ \(\d[\d,]*\)$/, '');
    b.setAttribute('aria-pressed', value === current ? 'true' : 'false');
  }
}

function syncCategorySelect(rows) {
  const sel = $('fCategory');
  const current = sel.value;
  const names = rows.map((r) => r.category);
  if (current && !names.includes(current)) names.unshift(current);
  sel.replaceChildren(el('option', { value: '', text: 'All' }), ...names.map((c) => el('option', { value: c, text: c })));
  sel.value = current;
}

function renderOutcome(sm) {
  const t = sm.totals;
  const box = clear($('outcomeBar'));
  if (!t.total) {
    box.append(el('p', { class: 'muted', text: 'No leads for this day yet.' }));
    return;
  }
  const parts = [
    { cls: 's-ok', label: 'Delivered', value: t.delivered },
    { cls: 's-rec', label: 'Recovered', value: t.recovered },
    { cls: 's-skip', label: 'Skipped', value: t.skipped },
    { cls: 's-fail', label: 'Failed', value: t.failed },
    { cls: 's-pend', label: 'Pending', value: t.pending },
  ];
  box.append(legend(), stack(parts, t.total));
  box.append(el('p', { class: 'muted', style: 'margin-top:10px', text: `Successful ${n(t.successful)} (${pct(t.successRate)}) · Failed or skipped ${n(t.skipped + t.failed)} (${pct(t.failureRate)}) · Pending ${n(t.pending)} of ${n(t.total)}` }));
}

function renderTrend(sm) {
  const box = clear($('trend'));
  const days = sm.trend;
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 640;
  const H = 210;
  const padL = 30;
  const padB = 26;
  const plotW = W - padL - 8;
  const plotH = H - padB - 8;
  const slot = plotW / days.length;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily leads, stacked by outcome, last 14 days');
  svg.style.width = '100%';
  svg.style.height = 'auto';
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  for (let i = 0; i <= 4; i += 1) {
    const y = 8 + (plotH * i) / 4;
    add('line', { x1: padL, x2: W - 8, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': 0.12 });
    add('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }, Math.round(max - (max * i) / 4));
  }
  const colors = [['successful', '#16a34a'], ['skipped', '#d97706'], ['failed', '#dc2626'], ['pending', '#94a3b8']];
  days.forEach((d, i) => {
    let y = 8 + plotH;
    const x = padL + slot * i + slot * 0.18;
    const w = slot * 0.64;
    const parts = [['successful', d.successful], ['skipped', d.skipped], ['failed', d.failed], ['pending', d.pending]];
    for (const [key, value] of parts) {
      if (!value) continue;
      const h = (value / max) * plotH;
      y -= h;
      const color = colors.find((c) => c[0] === key)[1];
      const rect = add('rect', { x, y, width: w, height: h, fill: color, rx: 2 });
      rect.append(document.createElementNS(svgNS, 'title'));
      rect.lastChild.textContent = `${d.day} · ${key}: ${value}`;
    }
    if (i % 2 === 0 || days.length <= 7) add('text', { x: x + w / 2, y: H - 8, 'text-anchor': 'middle' }, d.day.slice(5));
  });
  box.append(svg);
  box.append(el('div', { class: 'legend' }, [['s-ok', 'Successful'], ['s-skip', 'Skipped'], ['s-fail', 'Failed'], ['s-pend', 'Pending']]
    .map(([cls, text]) => el('span', {}, el('i', { class: cls }), text))));
}

function renderFlows(sm) {
  const box = clear($('flows'));
  if (!sm.workflows.length) {
    box.append(el('p', { class: 'muted', text: 'No workflow data yet.' }));
    return;
  }
  for (const f of sm.workflows) {
    const tone = f.state === 'running' ? 'OK' : 'FAILED';
    box.append(el('div', { class: 'kvrow' },
      el('span', { text: `${f.id} · ${f.name}` }),
      el('span', { class: `badge b-${tone === 'OK' ? 'DELIVERED' : 'FAILED'}`, text: f.state }),
    ));
  }
}

function renderConnections(sm) {
  const box = clear($('connections'));
  if (!sm.connections.length) {
    box.append(el('p', { class: 'muted', text: 'No connection data yet.' }));
    return;
  }
  for (const c of sm.connections) {
    box.append(el('div', { class: 'kvrow' },
      el('span', { text: c.name }),
      el('span', { class: `badge b-${c.ok === false ? 'FAILED' : 'DELIVERED'}`, text: c.ok === false ? 'Failing' : 'OK' }),
    ));
    if (c.ok === false && c.error) box.append(el('p', { class: 'muted', style: 'font-size:12px', text: c.error }));
  }
}

function meter(label, value, suffix) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const cls = v >= 90 ? 'hot' : v >= 75 ? 'warm' : '';
  return el('div', { style: 'margin:8px 0' },
    el('div', { class: 'kvrow', style: 'border:0;padding:0' }, el('span', { text: label }), el('strong', { text: `${(Number(value) || 0).toFixed(1)}${suffix}` })),
    el('div', { class: 'bar' }, el('span', { class: cls, style: `width:${v}%` })),
  );
}

function renderResources(sm) {
  const box = clear($('resources'));
  if (!sm.resources) {
    box.append(el('p', { class: 'muted', text: 'No resource samples yet.' }));
    return;
  }
  const r = sm.resources;
  box.append(
    meter('CPU', r.cpuPercent, '%'),
    meter('RAM in use', r.ramUsedPercent, '%'),
    el('p', { class: 'muted', style: 'font-size:12px', text: `Monitor process ${n(r.agentRssMb)} MB · sampled ${pkt(r.at)}` }),
  );
}

function renderErrors(sm) {
  const list = clear($('errors'));
  if (!sm.recentErrors.length) {
    list.append(el('li', { class: 'muted', text: 'No failed or manual-review leads recorded.' }));
    return;
  }
  for (const e of sm.recentErrors) {
    list.append(el('li', {},
      el('div', {}, el('strong', { text: e.leadId }), ' · ', el('span', { text: `${e.flow ?? ''} ${e.sheet ? `→ ${e.sheet}` : ''}` })),
      el('div', { text: `${e.status}: ${e.reason ?? ''}` }),
      el('div', { class: 'when', text: pkt(e.at) }),
      el('button', { type: 'button', class: 'ghost', style: 'margin-top:6px', onclick: () => openLead(e.leadId) }, 'Open record'),
    ));
  }
}

function renderAlerts(sm) {
  const list = clear($('alerts'));
  if (!sm.recentAlerts.length) {
    list.append(el('li', { class: 'muted', text: 'No alerts.' }));
    return;
  }
  for (const a of sm.recentAlerts) {
    list.append(el('li', {},
      el('div', {}, el('span', { class: `badge b-${a.severity === 'critical' ? 'FAILED' : a.severity === 'warning' ? 'SKIPPED' : 'DELIVERED'}`, text: a.severity }), ' ', a.title),
      el('div', { class: 'when', text: pkt(a.at) }),
    ));
  }
}

// ---------- lead activity table ----------
function leadsQuery() {
  const p = new URLSearchParams();
  const from = $('fFrom').value;
  const to = $('fTo').value;
  if (from || to) {
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  } else {
    p.set('day', S.day);
  }
  const map = { q: 'fQ', category: 'fCategory', status: 'fStatus', flow: 'fFlow', sort: 'fSort' };
  for (const [key, id] of Object.entries(map)) {
    const v = $(id).value.trim();
    if (v) p.set(key, v);
  }
  p.set('limit', String(PAGE));
  p.set('offset', String(S.offset));
  return `api/leads?${p.toString()}`;
}

async function refreshLeads() {
  const res = await getJson(leadsQuery());
  if (!res.ok) {
    showNotice(res.body.error ?? 'Lead list could not be loaded.');
    return;
  }
  renderLeads(res.body);
}

function renderLeads(data) {
  if (data.publicCopy) {
    $('leadCount').textContent = data.message;
    clear($('leadTable'));
    $('pageInfo').textContent = '';
    $('prevPage').disabled = true;
    $('nextPage').disabled = true;
    return;
  }
  S.leadsTotal = data.total;
  S.lastLeadsRows = data.rows.length;
  $('leadCount').textContent = `${n(data.total)} lead(s) match. Click a row to see its full history.`;
  const table = clear($('leadTable'));
  table.append(el('thead', {}, el('tr', {},
    ...['Record ID', 'Category', 'Status', 'Error', 'Attempts', 'Last updated'].map((h, i) => el('th', { class: i === 4 ? 'num' : '', text: h })))));
  const body = el('tbody');
  if (!data.rows.length) {
    body.append(el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'No leads match these filters.' })));
  }
  for (const r of data.rows) {
    const open = () => openLead(r.leadId);
    body.append(el('tr', { tabindex: '0', onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
      el('td', { text: r.leadId }),
      el('td', { text: r.category }),
      el('td', {}, badge(r.status), r.pendingRecovery && r.status !== 'SKIPPED' ? el('span', { class: 'muted', text: ' · retry queued' }) : null),
      el('td', { class: r.error ? 'err-text' : 'muted', text: r.error ?? '—' }),
      el('td', { class: 'num', text: n(r.attempts) }),
      el('td', { text: pkt(r.lastUpdated) }),
    ));
  }
  table.append(body);
  const from = data.total ? data.offset + 1 : 0;
  const to = data.offset + data.rows.length;
  $('pageInfo').textContent = data.total ? `${n(from)}–${n(to)} of ${n(data.total)}` : '0 leads';
  $('prevPage').disabled = data.offset === 0;
  $('nextPage').disabled = data.offset + data.rows.length >= data.total;
}

// ---------- Record ID search ----------
function renderLeadDetail(d) {
  const box = clear($('searchResult'));
  const banner = el('div', { class: `result-banner tone-${d.outcome}` },
    el('div', {},
      el('h3', { text: d.headline }),
      el('div', { class: 'sub', text: `Record ID ${d.leadId}${d.displayName ? ` · ${d.displayName}` : ''}` })),
    el('div', { class: 'sub', text: d.outcome === 'SKIPPED' ? (d.pendingRecovery ? 'Pending recovery' : '') : '' }),
  );
  const kv = (label, value) => el('div', {}, el('dt', { text: label }), el('dd', { text: value ?? '—' }));
  const lastRetry = d.destinations.map((x) => x.lastAttemptAt).filter(Boolean).sort().pop();
  const nextRetry = d.destinations.map((x) => x.nextRetryAt).filter(Boolean).sort()[0];
  const body = el('div', { class: 'result-body' },
    el('dl', { class: 'kv' },
      kv('Category', d.category),
      kv('Opportunity marked', pkt(d.opportunityDate)),
      kv('Lead created', pkt(d.createdAt)),
      kv('Source workflow(s)', [...new Set(d.destinations.map((x) => x.flow))].join(', ')),
      kv('Status', OUTCOME_LABEL[d.outcome]),
      kv('Pending recovery', d.outcome === 'SKIPPED' ? (d.pendingRecovery ? 'Yes' : 'No') : 'No'),
      kv('Delivered (verified)', d.deliveredAt ? pkt(d.deliveredAt) : '—'),
      kv('Skipped at', d.skippedAt ? pkt(d.skippedAt) : '—'),
      kv('Recovered at', d.recoveredAt ? pkt(d.recoveredAt) : '—'),
      kv('Retry attempts', n(d.attempts)),
      kv('Last retry', lastRetry ? pkt(lastRetry) : '—'),
      kv('Next retry', d.outcome === 'SKIPPED' && nextRetry ? pkt(nextRetry) : '—'),
      kv('Last activity', pkt(d.lastUpdated)),
    ),
    el('div', { class: 'action' }, el('strong', { text: 'Required action: ' }), d.action),
  );
  if (d.reason) body.append(el('p', { class: 'muted', text: `Reason: ${d.reason}` }));
  if (d.errorMessage && d.outcome !== 'DELIVERED') body.append(el('p', { class: 'err-text', text: `Error: ${d.errorMessage}` }));

  const rows = el('tbody');
  for (const r of d.destinations) {
    rows.append(el('tr', {},
      el('td', { text: r.flow ? `${r.flow} ${r.flowName ?? ''}` : '—' }),
      el('td', { text: r.isCross ? `${r.sheet} (cross-list)` : r.sheet }),
      el('td', { text: `${r.workbook} · ${r.worksheet}` }),
      el('td', { text: r.tableId ?? '—' }),
      el('td', {}, badge(r.outcome)),
      el('td', { class: 'num', text: n(r.attempts) }),
      el('td', { text: pkt(r.firstVerifiedAt ?? r.recoveredAt ?? r.nextRetryAt) }),
      el('td', { class: r.errorMessage ? 'err-text' : 'muted', text: r.errorMessage ?? r.reason ?? '—' }),
    ));
  }
  body.append(el('div', {},
    el('h3', { text: 'Destinations' }),
    el('div', { class: 'scroll' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ...['Workflow', 'Sheet', 'Workbook · worksheet', 'Table', 'Outcome', 'Attempts', 'Delivered / next retry', 'Error or reason']
        .map((h) => el('th', { text: h })))),
      rows,
    )),
  ));

  const history = el('ol', { class: 'timeline' });
  if (!d.history.length) history.append(el('li', { class: 'muted', text: 'No history recorded yet.' }));
  for (const e of d.history) {
    const change = e.from || e.to ? `${e.from ?? '—'} → ${e.to ?? '—'}` : e.type;
    history.append(el('li', {}, el('time', { text: pkt(e.at) }), el('strong', { text: change }),
      e.flow || e.sheet ? el('span', { class: 'muted', text: ` · ${[e.flow, e.sheet].filter(Boolean).join(' ')}` }) : null,
      e.reason ? el('div', { class: 'muted', style: 'font-size:12px', text: e.reason }) : null));
  }
  body.append(el('div', {}, el('h3', { text: 'Recovery and processing history' }), history));

  box.append(el('div', { class: 'result', role: 'region', 'aria-label': `Record ${d.leadId}` }, banner, body));
}

function renderNotFound(id) {
  const box = clear($('searchResult'));
  box.append(el('div', { class: 'result', role: 'region' },
    el('div', { class: 'result-banner tone-NOTFOUND' }, el('div', {}, el('h3', { text: 'Record Not Found' }), el('div', { class: 'sub', text: `No lead with Record ID ${id} has been seen by the monitor.` }))),
    el('div', { class: 'result-body' }, el('p', { class: 'muted', text: 'Check the number, or wait for the next check if this lead was only just marked in HubSpot.' })),
  ));
}

// `userAction` is false for the automatic 60-second refresh: it re-reads the same record without moving the page.
async function openLead(id, { userAction = true } = {}) {
  const clean = String(id).trim();
  if (userAction) {
    $('searchInput').value = clean;
    $('searchError').textContent = '';
  }
  if (!/^\d{4,30}$/.test(clean)) {
    if (userAction) $('searchError').textContent = 'Enter a numeric Lead or Record ID (digits only).';
    return;
  }
  S.searchId = clean;
  const res = await getJson(`api/lead/${encodeURIComponent(clean)}`);
  if (res.status === 404) {
    renderNotFound(clean);
  } else if (!res.ok) {
    clear($('searchResult')).append(el('p', { class: 'form-error', text: res.body.error ?? 'Search failed.' }));
  } else {
    renderLeadDetail(res.body);
  }
  if (userAction) $('searchResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- refresh loop ----------
async function refreshAll() {
  if (S.busy) return;
  S.busy = true;
  try {
    const dayQuery = S.day ? `?day=${encodeURIComponent(S.day)}` : '';
    const [st, sm] = await Promise.all([getJson('api/status'), getJson(`api/summary${dayQuery}`)]);
    renderLive(st.ok ? st.body : null);
    if (!sm.ok) {
      showNotice(sm.body.error ?? 'Summary could not be loaded.');
    } else {
      if (!S.today) S.today = sm.body.day;
      S.day = sm.body.day;
      $('dayInput').value = S.day;
      $('dayInput').max = S.today;
      $('dayNote').textContent = `${S.day === S.today ? 'Today' : 'Selected day'} · Pakistan time (PKT). A lead counts on the day its opportunity was marked.`;
      showNotice(PUBLIC ? PUBLIC_NOTICE : '');
      renderCards(sm.body);
      renderOutcome(sm.body);
      renderCategories(sm.body);
      renderTrend(sm.body);
      renderFlows(sm.body);
      renderConnections(sm.body);
      renderResources(sm.body);
      renderErrors(sm.body);
      renderAlerts(sm.body);
      $('updated').textContent = PUBLIC
        ? `public copy ${pkt(dataBundle.generatedAt)}`
        : STATIC && dataBundle ? `export ${pkt(dataBundle.generatedAt)}` : pkt(sm.body.generatedAt);
    }
    await refreshLeads();
    if (S.searchId) await openLead(S.searchId, { userAction: false });
  } finally {
    S.busy = false;
    S.nextAt = Date.now() + REFRESH_MS;
  }
}

function tick() {
  // The public copy has no server to poll: its data changes only when a newer export is loaded.
  if (STATIC) {
    if (PUBLIC) {
      $('countdown').textContent = 'every 5 min';
      if (Date.now() - lastPublicLoad > 5 * 60000 && !S.busy) loadPublicCopy().then(refreshAll);
      return;
    }
    $('countdown').textContent = 'load a newer file';
    return;
  }
  const left = Math.max(0, Math.ceil((S.nextAt - Date.now()) / 1000));
  $('countdown').textContent = S.busy ? 'refreshing…' : `${left}s`;
  if (left === 0 && !S.busy) refreshAll();
}

function applyTheme(mode) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}

function wire() {
  let saved = null;
  try {
    saved = localStorage.getItem('lrm-theme');
  } catch {
    saved = null;
  }
  applyTheme(saved);
  $('themeBtn').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem('lrm-theme', next);
    } catch {
      // private mode: the choice simply is not remembered
    }
  });

  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    openLead($('searchInput').value);
  });
  $('dayInput').addEventListener('change', (e) => {
    if (!e.target.value) return;
    S.day = e.target.value;
    S.offset = 0;
    S.nextAt = 0;
  });
  $('todayBtn').addEventListener('click', () => {
    if (!S.today) return;
    S.day = S.today;
    S.offset = 0;
    S.nextAt = 0;
  });
  for (const id of ['fQ', 'fCategory', 'fStatus', 'fFlow', 'fFrom', 'fTo', 'fSort']) {
    $(id).addEventListener('change', () => {
      S.offset = 0;
      refreshLeads();
      renderCategoryChipState();
    });
  }
  $('fQ').addEventListener('input', () => {
    S.offset = 0;
    refreshLeads();
  });
  $('clearFilters').addEventListener('click', () => {
    for (const id of ['fQ', 'fCategory', 'fStatus', 'fFlow', 'fFrom', 'fTo']) $(id).value = '';
    $('fSort').value = 'latest';
    S.offset = 0;
    refreshLeads();
    renderCategoryChipState();
  });
  $('prevPage').addEventListener('click', () => {
    S.offset = Math.max(0, S.offset - PAGE);
    refreshLeads();
  });
  $('nextPage').addEventListener('click', () => {
    S.offset += PAGE;
    refreshLeads();
  });
  setInterval(tick, 1000);
}

$('dataFile').addEventListener('change', loadDataFile);
wire();
detectMode().then(loadPublicCopy).then(refreshAll);
