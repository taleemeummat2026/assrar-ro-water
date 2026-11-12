/**
 * Billing and jar rules from the quotation (sections 4.2–4.3). Same rules as the apps' src/lib/billing.ts.
 *
 *  - Only "Delivered" and "Extra Jar" days are charged: jars × that day's rate.
 *  - "Not Taken", "Not Available" and "Paused" days are recorded but cost nothing.
 *  - Jar balance = jars issued at connection + jars delivered − empty jars collected.
 *  - Payments settle the opening balance first, then the oldest bill.
 */
import { addDays, addMonths, diffDays, monthDates, monthOf, monthRange, weekday } from './dates.js';

export const CHARGED = ['delivered', 'extra'];

export function isScheduled(plan, date) {
  if (date < plan.startDate) return false;
  switch (plan.schedule.type) {
    case 'daily':
      return true;
    case 'alternate':
      return diffDays(plan.startDate, date) % 2 === 0;
    case 'weekdays':
      return plan.schedule.days.includes(weekday(date));
    default:
      return false;
  }
}

export const chargeableJars = (e) => (CHARGED.includes(e.status) ? e.jarsDelivered : 0);
export const entryAmount = (e) => chargeableJars(e) * e.ratePerJar;

export function jarBalance(jarsIssued, entries, events = []) {
  const daily = entries.reduce((sum, e) => sum + chargeableJars(e) - e.emptiesCollected, jarsIssued);
  return events.reduce((sum, e) => sum + e.jars - e.emptiesCollected, daily);
}

export const emptySummary = (month) => ({
  month,
  totalJars: 0,
  amount: 0,
  delivered: 0,
  extra: 0,
  notTaken: 0,
  notAvailable: 0,
  paused: 0,
  emptiesCollected: 0,
});

export function summarizeMonth(month, entries) {
  const s = emptySummary(month);
  for (const e of entries) {
    if (monthOf(e.date) !== month) continue;
    s.totalJars += chargeableJars(e);
    s.amount += entryAmount(e);
    s.emptiesCollected += e.emptiesCollected;
    if (e.status === 'delivered') s.delivered++;
    else if (e.status === 'extra') s.extra++;
    else if (e.status === 'not_taken') s.notTaken++;
    else if (e.status === 'not_available') s.notAvailable++;
    else if (e.status === 'paused') s.paused++;
  }
  s.amount = round2(s.amount);
  return s;
}

const covers = (r, date) => r.type === 'pause' && r.status === 'approved' && r.fromDate && r.toDate && r.fromDate <= date && date <= r.toDate;
export const isPausedOn = (requests, date) => requests.some((r) => covers(r, date));
export const pausedUntil = (requests, date) => requests.find((r) => covers(r, date))?.toDate;
export const extraRequestedOn = (requests, date) =>
  requests.filter((r) => r.type === 'extra_jar' && r.status === 'approved' && r.date === date).reduce((s, r) => s + (r.jars ?? 0), 0);

export function dayKind(date, entry, ctx) {
  if (entry) return entry.status;
  if (date < ctx.plan.startDate) return 'inactive';
  if (!isScheduled(ctx.plan, date)) return 'off';
  if (isPausedOn(ctx.requests, date)) return 'paused';
  if (!ctx.active) return 'inactive';
  if (date > ctx.today) return 'upcoming';
  if (date === ctx.today) return 'pending';
  return 'missed';
}

export function buildDays(dates, entries, ctx) {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  return dates.map((date) => {
    const entry = byDate.get(date);
    return entry ? { date, kind: dayKind(date, entry, ctx), entry } : { date, kind: dayKind(date, undefined, ctx) };
  });
}

export const buildMonthDays = (month, entries, ctx) => buildDays(monthDates(month), entries, ctx);
export const lastNDays = (n, today) => Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));

export function allocatePayments(bills, totalPaid) {
  const paid = new Map();
  let remaining = totalPaid;
  for (const b of [...bills].sort((a, z) => a.month.localeCompare(z.month))) {
    const p = Math.max(0, Math.min(b.amount, remaining));
    paid.set(b.month, round2(p));
    remaining -= p;
  }
  return paid;
}

export function billStatus(amount, paid, closed) {
  if (!closed) return 'running';
  if (paid >= amount) return 'paid';
  return paid > 0 ? 'partial' : 'unpaid';
}

/**
 * Bills from `firstMonth` to `currentMonth`; months before `currentMonth` are closed.
 * `events` = delivered event orders ({ date, jars, amount }), added to the bill of their month.
 */
export function buildBills({ customerId, ratePerJar, firstMonth, currentMonth, entries, totalPaid, openingBalance = 0, events = [] }) {
  const summaries = monthRange(firstMonth, currentMonth).map((m) => {
    const s = summarizeMonth(m, entries);
    const ev = events.filter((e) => monthOf(e.date) === m);
    const eventAmount = round2(ev.reduce((sum, e) => sum + e.amount, 0));
    return { ...s, amount: round2(s.amount + eventAmount), eventOrders: ev.length, eventJars: ev.reduce((sum, e) => sum + e.jars, 0), eventAmount };
  });
  const paidByMonth = allocatePayments(summaries, Math.max(0, totalPaid - openingBalance));
  return summaries.map((s) => {
    const closed = s.month < currentMonth;
    const paid = paidByMonth.get(s.month) ?? 0;
    return {
      ...s,
      customerId,
      ratePerJar,
      status: billStatus(s.amount, paid, closed),
      paidAmount: paid,
      dueAmount: round2(Math.max(0, s.amount - paid)),
      ...(closed ? { generatedAt: new Date(`${addMonths(s.month, 1)}-01T00:05:00+05:30`).toISOString() } : {}),
    };
  });
}

/** Opening balance + closed bills − payments. Negative = advance. */
export function outstandingDues(bills, totalPaid, openingBalance = 0) {
  const billed = bills.filter((b) => b.status !== 'running').reduce((s, b) => s + b.amount, 0);
  return round2(openingBalance + billed - totalPaid);
}

export const round2 = (n) => Math.round(n * 100) / 100;
