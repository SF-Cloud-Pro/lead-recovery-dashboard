// What the dashboard shows, computed from the stored records and events. Pure functions: no file or network access.
//
// Units and rules (also explained on the dashboard):
// - A lead is a Record ID. It is counted ONCE, however many workflows, sheets or retries it has.
// - Its outcome is the WORST outcome among all its sheet rows. A lead counts as delivered only when every
//   row it should have is verified in its sheet. A missing cross-list row therefore shows as not delivered.
// - "Today" is the calendar day in Asia/Karachi, taken from the lead's opportunity date.
// - Retry attempts are counted per lead but never make it a new lead.
import { destinationFor, FLOW_NAMES } from './destinations.mjs';

export const TZ = 'Asia/Karachi';
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const dayOf = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? DAY.format(d) : null;
};
export const todayKey = (now = new Date()) => DAY.format(now);

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The engine's status for one sheet row, in the words the dashboard uses.
export function outcomeOfRecord(r) {
  switch (r.status) {
    case 'Verified':
    case 'Already Exists':
      return 'DELIVERED';
    case 'Recovered':
      return 'RECOVERED';
    case 'Failed':
    case 'Retrying':
      return 'SKIPPED';
    case 'Manual Review Required':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

export const HEADLINE = {
  DELIVERED: 'SUCCESSFULLY DELIVERED',
  RECOVERED: 'RECOVERED',
  SKIPPED: 'SKIPPED',
  PENDING: 'PENDING',
  FAILED: 'FAILED',
};

const SEVERITY = { FAILED: 5, SKIPPED: 4, PENDING: 3, RECOVERED: 2, DELIVERED: 1 };
const flowNumber = (f) => Number(String(f ?? '').replace(/\D/g, '')) || 99;
const latest = (...xs) => xs.filter(Boolean).sort().pop() ?? null;
const earliest = (...xs) => xs.filter(Boolean).sort()[0] ?? null;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// Groups sheet rows by Record ID into one lead each.
export function buildLeads(records) {
  const byLead = new Map();
  for (const r of records) {
    if (!byLead.has(r.leadId)) byLead.set(r.leadId, []);
    byLead.get(r.leadId).push(r);
  }
  const leads = [];
  for (const [leadId, recs] of byLead) {
    const ordered = [...recs].sort((a, b) => flowNumber(a.flow) - flowNumber(b.flow) || Number(a.isCross) - Number(b.isCross));
    const primary = ordered.find((r) => !r.isCross) ?? ordered[0];
    const worst = [...recs].sort((a, b) => SEVERITY[outcomeOfRecord(b)] - SEVERITY[outcomeOfRecord(a)])[0];
    const outcome = outcomeOfRecord(worst);
    const delivered = recs.filter((r) => ['DELIVERED', 'RECOVERED'].includes(outcomeOfRecord(r)));
    leads.push({
      leadId,
      day: dayOf(primary.opportunityDate ?? primary.firstSeenAt),
      category: primary.category ?? 'Unknown',
      flows: [...new Set(recs.map((r) => r.flow).filter(Boolean))].sort(),
      outcome,
      pendingRecovery: recs.some((r) => outcomeOfRecord(r) === 'SKIPPED'),
      reason: worst.reason ?? null,
      errorClass: worst.errorClass ?? null,
      errorMessage: worst.errorMessage ?? null,
      displayName: recs.map((r) => r.displayName).find(Boolean) ?? null,
      opportunityDate: primary.opportunityDate ?? null,
      createdAt: recs.map((r) => r.createdAt).find(Boolean) ?? null,
      attempts: recs.reduce((n, r) => n + (r.attempts ?? 0), 0),
      skippedAt: earliest(...recs.map((r) => r.firstMissingAt)),
      recoveredAt: latest(...recs.map((r) => r.recoveredAt)),
      deliveredAt: earliest(...delivered.map((r) => r.firstVerifiedAt)),
      lastUpdated: latest(...recs.map((r) => r.statusChangedAt ?? r.firstSeenAt)),
      records: ordered,
    });
  }
  return leads;
}

export function tally(leads) {
  const t = { total: leads.length, delivered: 0, recovered: 0, skipped: 0, failed: 0, pending: 0, skippedAtAny: 0 };
  for (const l of leads) {
    if (l.outcome === 'DELIVERED') t.delivered += 1;
    else if (l.outcome === 'RECOVERED') t.recovered += 1;
    else if (l.outcome === 'SKIPPED') t.skipped += 1;
    else if (l.outcome === 'FAILED') t.failed += 1;
    else t.pending += 1;
    if (l.skippedAt) t.skippedAtAny += 1;
  }
  t.successful = t.delivered + t.recovered;
  t.successRate = pct(t.successful, t.total);
  t.failureRate = pct(t.skipped + t.failed, t.total);
  return t;
}

export function categoryRows(leads) {
  const groups = new Map();
  for (const l of leads) {
    if (!groups.has(l.category)) groups.set(l.category, []);
    groups.get(l.category).push(l);
  }
  return [...groups.entries()]
    .map(([category, ls]) => ({ category, ...tally(ls) }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

export function trend(leads, endDay, days = 14) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addDays(endDay, -i);
    const t = tally(leads.filter((l) => l.day === day));
    out.push({ day, total: t.total, successful: t.successful, skipped: t.skipped, failed: t.failed, pending: t.pending, recovered: t.recovered });
  }
  return out;
}

export function daySummary(leads, day) {
  const dayLeads = leads.filter((l) => l.day === day);
  return { day, totals: tally(dayLeads), categories: categoryRows(dayLeads) };
}

const LABEL = { DELIVERED: 'Delivered', RECOVERED: 'Recovered', SKIPPED: 'Skipped', PENDING: 'Pending', FAILED: 'Failed' };

export function listLeads(leads, f = {}) {
  let rows = leads;
  if (f.day) rows = rows.filter((l) => l.day === f.day);
  if (f.from) rows = rows.filter((l) => l.day && l.day >= f.from);
  if (f.to) rows = rows.filter((l) => l.day && l.day <= f.to);
  if (f.category) rows = rows.filter((l) => l.category === f.category);
  if (f.status) rows = rows.filter((l) => l.outcome === f.status);
  if (f.flow) rows = rows.filter((l) => l.flows.includes(f.flow));
  if (f.q) rows = rows.filter((l) => l.leadId.startsWith(f.q));
  const sign = f.sort === 'oldest' ? 1 : -1;
  rows = [...rows].sort((a, b) => sign * String(a.lastUpdated ?? '').localeCompare(String(b.lastUpdated ?? '')) || a.leadId.localeCompare(b.leadId));
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
  const offset = Math.max(Number(f.offset) || 0, 0);
  return {
    total: rows.length,
    limit,
    offset,
    rows: rows.slice(offset, offset + limit).map((l) => ({
      leadId: l.leadId,
      displayName: l.displayName,
      day: l.day,
      category: l.category,
      flows: l.flows,
      status: l.outcome,
      statusLabel: LABEL[l.outcome],
      pendingRecovery: l.pendingRecovery,
      error: l.errorMessage,
      attempts: l.attempts,
      lastUpdated: l.lastUpdated,
    })),
  };
}

const ACTION = {
  DELIVERED: 'None. The monitor verified exactly one row in the sheet.',
  RECOVERED: 'None. It was recovered automatically and verified in the sheet.',
  PENDING: 'Waiting for its workflow run or wait window. No action yet.',
  FAILED: 'Needs a person: check the sheet and the Zapier run. The monitor will not replay it automatically.',
};

export function notFound(leadId) {
  return { found: false, leadId, message: 'Record Not Found' };
}

// Full history for one Record ID: every flow and sheet it touches, with the required action.
export function leadDetail(lead, events) {
  const outcome = lead.outcome;
  const action =
    outcome === 'SKIPPED'
      ? lead.records.some((r) => r.waitingForConnection)
        ? 'Re-authorize the Excel or HubSpot connection. The monitor retries after that.'
        : 'Automatic retry is scheduled. No action needed unless it fails again.'
      : ACTION[outcome];
  return {
    found: true,
    leadId: lead.leadId,
    outcome,
    headline: HEADLINE[outcome],
    statusLabel: LABEL[outcome],
    displayName: lead.displayName,
    category: lead.category,
    opportunityDate: lead.opportunityDate,
    createdAt: lead.createdAt,
    skippedAt: lead.skippedAt,
    recoveredAt: lead.recoveredAt,
    deliveredAt: lead.deliveredAt,
    lastUpdated: lead.lastUpdated,
    pendingRecovery: lead.pendingRecovery,
    attempts: lead.attempts,
    reason: lead.reason,
    errorMessage: lead.errorMessage,
    errorClass: lead.errorClass,
    action,
    destinations: lead.records.map((r) => ({
      flow: r.flow,
      flowName: FLOW_NAMES[r.flow] ?? null,
      isCross: r.isCross,
      sheet: r.sheet,
      ...destinationFor(r.sheet),
      outcome: outcomeOfRecord(r),
      status: r.status,
      reason: r.reason,
      errorMessage: r.errorMessage,
      attempts: r.attempts,
      firstMissingAt: r.firstMissingAt,
      lastAttemptAt: r.lastAttemptAt,
      nextRetryAt: r.nextRetryAt,
      firstVerifiedAt: r.firstVerifiedAt,
      recoveredAt: r.recoveredAt,
      pendingRecovery: outcomeOfRecord(r) === 'SKIPPED',
      waitingForConnection: r.waitingForConnection,
    })),
    history: events,
  };
}
