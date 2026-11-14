// The dashboard API as pure functions over the monitor's data. The local server (server.mjs) and the GitHub Pages copy
// both call this same code, so they always show the same numbers. Nothing here touches files, the network or the database.
import { buildLeads, daySummary, trend, listLeads, leadDetail, notFound, todayKey, tally, addDays, TZ } from './reporting.mjs';

const STATUSES = new Set(['DELIVERED', 'RECOVERED', 'SKIPPED', 'PENDING', 'FAILED']);
const LIVE_WINDOW_MIN = 15;
const ALERTS_SHOWN = 15;
const ERRORS_SHOWN = 25;

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const ok = (body) => ({ status: 200, body });
const bad = (error) => ({ status: 400, body: { error } });

export function liveState(cycle, now) {
  if (!cycle) return 'no-data';
  const ageMin = (now.getTime() - Date.parse(cycle.at)) / 60000;
  return ageMin <= LIVE_WINDOW_MIN && cycle.fresh ? 'live' : 'stale';
}

// Work done once per data set (leads are grouped, history sorted, recent errors picked).
const prepared = new WeakMap();
function prepare(data) {
  let p = prepared.get(data);
  if (p) return p;
  const leads = buildLeads(data.records ?? []);
  const byId = new Map(leads.map((l) => [l.leadId, l]));
  const events = [...(data.events ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq ?? 0) - (b.seq ?? 0));
  const eventsByLead = new Map();
  for (const e of events) {
    if (!eventsByLead.has(e.leadId)) eventsByLead.set(e.leadId, []);
    eventsByLead.get(e.leadId).push({
      at: e.at,
      cycleId: e.cycleId,
      type: e.type,
      flow: e.flow,
      sheet: e.sheet,
      from: e.from,
      to: e.to,
      reason: e.reason,
      attempt: e.attempt,
      requestKey: e.requestKey,
    });
  }
  const recentErrors = events
    .filter((e) => e.type === 'status' && (e.to === 'Failed' || e.to === 'Manual Review Required'))
    .reverse()
    .slice(0, ERRORS_SHOWN)
    .map((e) => ({ at: e.at, leadId: e.leadId, flow: e.flow, sheet: e.sheet, status: e.to, reason: e.reason }));
  p = { leads, byId, eventsByLead, recentErrors };
  prepared.set(data, p);
  return p;
}

function statusBody(data, now) {
  const cycle = data.cycle ?? null;
  const at = cycle ? Date.parse(cycle.at) : null;
  return {
    live: liveState(cycle, now),
    lastCycleAt: cycle?.at ?? null,
    lastCycleId: cycle?.cycleId ?? null,
    health: cycle?.health ?? null,
    healthReason: cycle?.healthReason ?? null,
    mode: cycle?.mode ?? null,
    snapshotFresh: cycle?.fresh ?? null,
    snapshotAgeMinutes: cycle?.snapshotAgeMinutes ?? null,
    nextCycleExpectedAt: at ? new Date(at + data.intervalMinutes * 60000).toISOString() : null,
    intervalMinutes: data.intervalMinutes,
    tz: TZ,
    serverTime: now.toISOString(),
  };
}

// The public copy carries totals only (see lib/public-data.mjs). Its summaries come straight from that file.
function publicLive(data, now) {
  const c = data.cycle ?? null;
  if (!c) return 'no-data';
  const ageMin = (now.getTime() - Date.parse(c.at)) / 60000;
  return ageMin <= LIVE_WINDOW_MIN && c.fresh ? 'live' : 'stale';
}

function publicSummary(data, day, now) {
  const d = data.days?.[day] ?? null;
  const cycle = data.cycle ?? null;
  const flows = data.flows ?? [];
  const trendRows = [];
  for (let i = 13; i >= 0; i -= 1) {
    const dd = addDays(day, -i);
    const t = data.days?.[dd]?.totals ?? tally([]);
    trendRows.push({ day: dd, total: t.total, successful: t.successful, skipped: t.skipped, failed: t.failed, pending: t.pending, recovered: t.recovered });
  }
  return ok({
    generatedAt: now.toISOString(),
    tz: TZ,
    day,
    isToday: day === todayKey(now),
    dayAvailable: Boolean(d),
    live: publicLive(data, now),
    lastCycleAt: cycle?.at ?? null,
    totals: d?.totals ?? tally([]),
    categories: d?.categories ?? [],
    trend: trendRows,
    workflows: flows.map((f) => ({
      id: f.id,
      name: f.name,
      enabled: f.enabled !== false,
      triggerActive: f.triggerActive !== false,
      state: f.enabled === false ? 'off' : f.triggerActive === false ? 'trigger inactive' : 'running',
    })),
    connections: data.connections ?? [],
    activeWorkflows: flows.filter((f) => f.enabled !== false && f.triggerActive !== false).length,
    runsInProgress: cycle?.runsInProgress ?? 0,
    resources: cycle?.resources ?? null,
    recentErrors: [],
    recentAlerts: [],
    publicCopy: true,
  });
}

function summaryBody(data, params, now) {
  const day = params.get('day') ?? todayKey(now);
  if (!isDay(day)) return bad('day must be YYYY-MM-DD');
  if (data.public) return publicSummary(data, day, now);
  const p = prepare(data);
  const cycle = data.cycle ?? null;
  const ds = daySummary(p.leads, day);
  return ok({
    generatedAt: now.toISOString(),
    tz: TZ,
    day,
    isToday: day === todayKey(now),
    live: liveState(cycle, now),
    lastCycleAt: cycle?.at ?? null,
    totals: ds.totals,
    categories: ds.categories,
    trend: trend(p.leads, day, 14),
    workflows: (cycle?.flows ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      enabled: f.enabled !== false,
      triggerActive: f.triggerActive !== false,
      state: f.enabled === false ? 'off' : f.triggerActive === false ? 'trigger inactive' : 'running',
    })),
    connections: cycle?.connections ?? [],
    activeWorkflows: (cycle?.flows ?? []).filter((f) => f.enabled !== false && f.triggerActive !== false).length,
    runsInProgress: cycle?.runsInProgress ?? 0,
    resources: cycle
      ? { cpuPercent: cycle.cpuPercent, ramUsedPercent: cycle.ramUsedPercent, agentRssMb: cycle.agentRssMb, at: cycle.at }
      : null,
    recentErrors: p.recentErrors,
    recentAlerts: (data.alerts ?? []).slice(0, ALERTS_SHOWN).map((a) => ({ at: a.at, severity: a.severity, title: a.title, detail: a.detail })),
  });
}

const PUBLIC_ONLY = 'Lead activity and Record ID search are available only in the private copy.';

function leadsBody(data, params) {
  if (data.public) return { status: 200, body: { total: 0, limit: 50, offset: 0, rows: [], publicCopy: true, message: PUBLIC_ONLY } };
  const filters = {
    day: params.get('day') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    category: params.get('category') ?? undefined,
    status: params.get('status') ?? undefined,
    flow: params.get('flow') ?? undefined,
    q: params.get('q') ?? undefined,
    sort: params.get('sort') ?? 'latest',
    limit: params.get('limit') ?? 50,
    offset: params.get('offset') ?? 0,
  };
  for (const k of ['day', 'from', 'to']) if (filters[k] !== undefined && !isDay(filters[k])) return bad(`${k} must be YYYY-MM-DD`);
  if (filters.status !== undefined && !STATUSES.has(filters.status)) return bad('unknown status');
  if (filters.flow !== undefined && !/^WF\d{1,2}$/.test(filters.flow)) return bad('unknown workflow');
  if (filters.q !== undefined && !/^\d{0,30}$/.test(filters.q)) return bad('Record ID search takes digits only');
  if (filters.category !== undefined && filters.category.length > 80) return bad('category too long');
  if (!['latest', 'oldest'].includes(filters.sort)) return bad('sort must be latest or oldest');
  return ok(listLeads(prepare(data).leads, filters));
}

function leadBody(data, pathname) {
  if (data.public) return { status: 403, body: { error: PUBLIC_ONLY, publicCopy: true } };
  let id;
  try {
    id = decodeURIComponent(pathname.slice('/api/lead/'.length)).trim();
  } catch {
    return bad('bad Record ID');
  }
  if (!/^\d{4,30}$/.test(id)) return bad('Enter a numeric Lead or Record ID');
  const p = prepare(data);
  const lead = p.byId.get(id);
  if (!lead) return { status: 404, body: notFound(id) };
  return ok(leadDetail(lead, p.eventsByLead.get(id) ?? []));
}

// Answers one GET request. `path` is the URL path (e.g. /api/summary), `params` is a URLSearchParams.
export function apiResponse({ path, params, data, now = new Date() }) {
  if (path === '/api/status') return ok(statusBody(data, now));
  if (path === '/api/summary') return summaryBody(data, params, now);
  if (path === '/api/leads') return leadsBody(data, params);
  if (path.startsWith('/api/lead/')) return leadBody(data, path);
  return { status: 404, body: { error: 'Not found' } };
}
