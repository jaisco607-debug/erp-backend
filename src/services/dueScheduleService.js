// Due schedule (service ACC_REPORTS, read only): the money still to come in from customers and still to go out to vendors, by DUE DATE.
// Every unpaid approved invoice / bill is put in a bucket by how many days from the report date it falls due: overdue ranges, due today and the coming
// ranges (next 15 days, 16-30 ...). The bucket days are chosen by the caller (default 15, 30, 60). Amounts are the BALANCE still unpaid, exact (cents as BigInt, shown as strings).
const accountService = require('./accountService');
const { range } = require('./trialBalanceService');
const { openItems } = require('./partyReportService');

const { fromCents } = accountService.internals;
const DAY_MS = 86400000;
const DEFAULT_BUCKETS = [15, 30, 60];

const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / DAY_MS);
const matches = (needle, ...texts) => !needle || texts.some((t) => t && String(t).toLowerCase().includes(needle));

/** The buckets in screen order (oldest overdue first). `day` = due date minus report date: negative = overdue. */
function makeBuckets(days) {
  const out = [];
  const last = days[days.length - 1];
  out.push({ key: `OVERDUE_OVER_${last}`, label: `Overdue over ${last} days`, minDay: null, maxDay: -(last + 1), side: 'OVERDUE' });
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const prev = i ? days[i - 1] : 0;
    out.push({ key: `OVERDUE_${prev + 1}_${days[i]}`, label: `Overdue ${prev + 1}-${days[i]} days`, minDay: -days[i], maxDay: -(prev + 1), side: 'OVERDUE' });
  }
  out.push({ key: 'DUE_TODAY', label: 'Due today', minDay: 0, maxDay: 0, side: 'TODAY' });
  days.forEach((d, i) => {
    const prev = i ? days[i - 1] : 0;
    out.push({ key: `DUE_${prev + 1}_${d}`, label: `Due in ${prev + 1}-${d} days`, minDay: prev + 1, maxDay: d, upToDays: d, side: 'UPCOMING' });
  });
  out.push({ key: `DUE_AFTER_${last}`, label: `Due after ${last} days`, minDay: last + 1, maxDay: null, side: 'UPCOMING' });
  return out;
}
const bucketOf = (buckets, day) => buckets.find((b) => (b.minDay === null || day >= b.minDay) && (b.maxDay === null || day <= b.maxDay));

async function side(companyId, kind, date, buckets, { needle, detail }) {
  const { items } = await openItems(companyId, kind, date);
  const rows = items.filter((i) => matches(needle, i.partyName, i.ntn, i.cnic, String(i.partyCode), i.label, i.billNo));
  const sums = new Map(buckets.map((b) => [b.key, { n: 0, bal: 0n }]));
  const parties = new Map();
  const docs = [];
  let total = 0n;
  for (const i of rows) {
    const bal = i._c.amount - i._c.before;
    const day = daysBetween(date, i.dueDate);
    const b = bucketOf(buckets, day);
    const s = sums.get(b.key);
    s.n += 1; s.bal += bal; total += bal;
    const p = parties.get(i.partyId) || { partyId: i.partyId, code: i.partyCode, name: i.partyName, n: 0, total: 0n, by: new Map(buckets.map((x) => [x.key, 0n])) };
    p.n += 1; p.total += bal; p.by.set(b.key, p.by.get(b.key) + bal);
    parties.set(i.partyId, p);
    if (detail) docs.push({ bucket: b.key, id: i.id, label: i.label, billNo: i.billNo, date: i.date, dueDate: i.dueDate, daysToDue: day, partyId: i.partyId, partyName: i.partyName, amount: i.amount, balance: fromCents(bal) });
  }
  let running = 0n;
  const out = buckets.map((b) => {
    const s = sums.get(b.key);
    if (b.side === 'UPCOMING' || b.side === 'TODAY') running += s.bal;
    return { key: b.key, label: b.label, side: b.side, count: s.n, balance: fromCents(s.bal), ...(b.upToDays ? { upToDays: b.upToDays, cumulative: fromCents(running) } : {}), _c: s.bal };
  });
  const overdue = out.filter((b) => b.side === 'OVERDUE').reduce((t, b) => t + b._c, 0n);
  return {
    total: fromCents(total), count: rows.length, overdue: fromCents(overdue), notYetDue: fromCents(total - overdue), buckets: out,
    parties: [...parties.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
      partyId: p.partyId, code: p.code, name: p.name, count: p.n, total: fromCents(p.total), buckets: Object.fromEntries(buckets.map((b) => [b.key, fromCents(p.by.get(b.key))])),
    })),
    ...(detail ? { documents: docs.sort((a, b) => a.daysToDue - b.daysToDue || a.partyName.localeCompare(b.partyName)) } : {}),
  };
}

/** GET /accounting/due-schedule : money to come in (customers) and to go out (vendors) by due date, and the net of the two in every bucket. */
async function dueSchedule(req, { date, buckets: raw, search, detail }) {
  const { companyId } = req.user;
  const { to } = await range(companyId, { dateTo: date });
  const days = [...new Set(raw && raw.length ? raw : DEFAULT_BUCKETS)].sort((a, b) => a - b);
  const buckets = makeBuckets(days);
  const needle = search ? String(search).trim().toLowerCase() : '';
  const receivable = await side(companyId, 'SALES', to, buckets, { needle, detail });
  const payable = await side(companyId, 'PURCHASE', to, buckets, { needle, detail });
  const net = buckets.map((b, i) => ({ key: b.key, label: b.label, balance: fromCents(receivable.buckets[i]._c - payable.buckets[i]._c) }));
  const strip = (s) => ({ ...s, buckets: s.buckets.map(({ _c, ...rest }) => rest) });
  return { date: to, bucketDays: days, receivable: strip(receivable), payable: strip(payable), net, netTotal: fromCents(receivable.buckets.reduce((t, b) => t + b._c, 0n) - payable.buckets.reduce((t, b) => t + b._c, 0n)) };
}

module.exports = { dueSchedule, makeBuckets, DEFAULT_BUCKETS };
