// GET /payroll/overview?month=: everything the Payroll Overview page shows, in one response. Aggregate queries only; each part is worked out on its own and a part that fails is left out
// of the answer instead of failing the whole page. The numbers are the same as on the screens they come from: Payroll Summary (runs, totals), Salary Tax Report (compliance.tax),
// the approval lists (approvals.waiting) and the attendance summary (attendance).
const { sequelize } = require('../models');
const { today } = require('../utils/dates');
const accountService = require('./accountService');
const { runsOfMonth } = require('./payrollRunService');

const { toCents, fromCents } = accountService.internals;
const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (m) => `${NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const m2 = (v) => fromCents(toCents(String(v == null ? 0 : v)));
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });

const addMonths = (month, n) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function employeesPart(companyId) {
  const groups = await q(`SELECT g.id, g.name, g."systemKey", g."isActive", count(e.id) FILTER (WHERE NOT e."isClosed")::int AS employees, count(e.id) FILTER (WHERE e."isClosed")::int AS closed
    FROM payroll_groups g LEFT JOIN payroll_employees e ON e."groupId" = g.id WHERE g."companyId" = :companyId GROUP BY g.id ORDER BY g."sortOrder", lower(g.name)`, { companyId });
  const [t] = await q(`SELECT count(*) FILTER (WHERE NOT "isClosed")::int AS total, count(*) FILTER (WHERE "isClosed")::int AS closed FROM payroll_employees WHERE "companyId" = :companyId`, { companyId });
  return { total: t.total, closed: t.closed, groups: groups.map((g) => ({ id: g.id, name: g.name, isDefault: Boolean(g.systemKey), isActive: g.isActive, employees: g.employees, closed: g.closed })) };
}

/** The six months ending at `month`: payrolls, employees, net (approved), paid and balance - the totals of the Payroll Summary of each month. */
async function trendPart(companyId, month) {
  const from = addMonths(month, -5);
  const rows = await q(`SELECT to_char(r.month, 'YYYY-MM') AS month, count(DISTINCT r.id)::int AS payrolls, count(s.id) FILTER (WHERE s.status <> 'SUSPENDED')::int AS employees,
      COALESCE(SUM(s."netAmount") FILTER (WHERE s.status = 'APPROVED'), 0)::text AS net, COALESCE(SUM(s."paidAmount") FILTER (WHERE s.status = 'APPROVED'), 0)::text AS paid
    FROM payroll_runs r LEFT JOIN payroll_slips s ON s."runId" = r.id WHERE r."companyId" = :companyId AND r.month BETWEEN :from AND :to GROUP BY 1`, { companyId, from: `${from}-01`, to: `${month}-01` });
  const by = new Map(rows.map((r) => [r.month, r]));
  return Array.from({ length: 6 }, (_, i) => {
    const m = addMonths(from, i);
    const r = by.get(m);
    const net = r ? toCents(r.net) : 0n;
    const paid = r ? toCents(r.paid) : 0n;
    return { month: m, monthLabel: label(m), payrolls: r ? r.payrolls : 0, employees: r ? r.employees : 0, net: fromCents(net), paid: fromCents(paid), balance: fromCents(net - paid) };
  });
}

/** What the month's payslips (not suspended) add up to; basic = the basic earned (gross without the overtime), so basic + overtime = gross. */
async function breakdownPart(companyId, month) {
  const [t] = await q(`SELECT COALESCE(SUM((s.calc->>'overtimeAmount')::numeric), 0)::text AS overtime, COALESCE(SUM(s."grossAmount"), 0)::text AS gross, COALESCE(SUM(s."additionsAmount"), 0)::text AS additions,
      COALESCE(SUM(s."loanAmount"), 0)::text AS loan, COALESCE(SUM(s."eobiAmount"), 0)::text AS eobi, COALESCE(SUM(s."taxAmount"), 0)::text AS "incomeTax",
      COALESCE(SUM(s."othersDeductAmount"), 0)::text AS other, COALESCE(SUM(s."deductionsAmount"), 0)::text AS deductions, COALESCE(SUM(s."netAmount"), 0)::text AS net
    FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" WHERE r."companyId" = :companyId AND r.month = :first AND s.status <> 'SUSPENDED'`, { companyId, first: `${month}-01` });
  const gross = toCents(t.gross);
  const overtime = toCents(t.overtime);
  return { basic: fromCents(gross - overtime), overtime: fromCents(overtime), additions: m2(t.additions), gross: fromCents(gross), loan: m2(t.loan), eobi: m2(t.eobi), incomeTax: m2(t.incomeTax),
    otherDeductions: m2(t.other), deductions: m2(t.deductions), net: m2(t.net) };
}

async function attendancePart(companyId, month) {
  const next = addMonths(month, 1);
  const day = today();
  const start = `${month}-01` < day ? `${month}-01` : day; // the punches of the month and of today (which may be outside it)
  const [t] = await q(`SELECT count(*) FILTER (WHERE (p."punchAt" AT TIME ZONE 'Asia/Karachi')::date = CAST(:today AS date))::int AS "punchesToday",
      count(*) FILTER (WHERE p."punchAt" >= CAST(:from AS timestamptz) AND p."punchAt" < CAST(:to AS timestamptz))::int AS "monthPunches",
      count(DISTINCT p."empCode") FILTER (WHERE e.id IS NULL AND p."punchAt" >= CAST(:from AS timestamptz) AND p."punchAt" < CAST(:to AS timestamptz))::int AS "unmappedIds"
    FROM payroll_punches p LEFT JOIN payroll_employees e ON e."companyId" = p."companyId" AND e.code = p."empCode"
    WHERE p."companyId" = :companyId AND p."punchAt" >= CAST(:wideFrom AS timestamptz)`,
  { companyId, today: day, from: `${month}-01T00:00:00+05:00`, to: `${next}-01T00:00:00+05:00`, wideFrom: `${start}T00:00:00+05:00` });
  return t;
}

async function compliancePart(companyId, month) {
  const first = `${month}-01`;
  const [eobi] = await q(`SELECT (SELECT count(*) FROM eobi_list_rows r WHERE r."companyId" = :companyId AND r.month = :first)::int AS "listEmployees",
      (SELECT count(*) FROM payroll_employees e WHERE e."companyId" = :companyId AND e.status = 'CONFIRMED' AND e."joiningDate" <= (CAST(:first AS date) + interval '1 month' - interval '1 day')
        AND (NOT e."isClosed" OR e."leavingDate" >= CAST(:first AS date)))::int AS "workingEmployees"`, { companyId, first });
  // the same figures as the Salary Tax Report cards: withheld = deducted, paid = paid to the government, toPay = approved and on no voucher yet
  const [tax] = await q(`SELECT COALESCE(SUM(s."taxAmount"), 0)::text AS withheld, COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED' AND v.status = 'CONFIRMED'), 0)::text AS paid,
      COALESCE(SUM(s."taxAmount") FILTER (WHERE s.status = 'APPROVED' AND v.id IS NULL), 0)::text AS "toPay"
    FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" LEFT JOIN salary_tax_voucher_lines vl ON vl."slipId" = s.id LEFT JOIN salary_tax_vouchers v ON v.id = vl."voucherId"
    WHERE s."companyId" = :companyId AND r.month = :first AND s.status <> 'SUSPENDED' AND s."taxAmount" > 0`, { companyId, first });
  return { eobi, tax: { withheld: m2(tax.withheld), paid: m2(tax.paid), toPay: m2(tax.toPay) } };
}

async function approvalsPart(companyId) {
  const [t] = await q(`SELECT (SELECT count(*) FROM payroll_joining_applications WHERE "companyId" = :companyId AND status = 'IN_REVIEW')::int AS joining,
      (SELECT count(*) FROM payroll_leaves WHERE "companyId" = :companyId AND status = 'IN_REVIEW')::int AS leave,
      (SELECT count(*) FROM payroll_resignations WHERE "companyId" = :companyId AND status = 'IN_REVIEW')::int AS resignation,
      (SELECT count(*) FROM payroll_loans WHERE "companyId" = :companyId AND status = 'IN_REVIEW')::int AS loan`, { companyId });
  return { waiting: { ...t, total: t.joining + t.leave + t.resignation + t.loan } };
}

async function get(req, { month } = {}) {
  const { companyId } = req.user;
  const m = month || today().slice(0, 7);
  const parts = {
    employees: () => employeesPart(companyId),
    payroll: () => runsOfMonth(companyId, m).then((r) => ({ totals: r.totals, runs: r.data })),
    trend: () => trendPart(companyId, m),
    breakdown: () => breakdownPart(companyId, m),
    attendance: () => attendancePart(companyId, m),
    compliance: () => compliancePart(companyId, m),
    approvals: () => approvalsPart(companyId),
  };
  const out = { month: m, monthLabel: label(m) };
  await Promise.all(Object.entries(parts).map(async ([key, fn]) => {
    try { out[key] = await fn(); } catch (e) { console.error(`payroll overview: ${key} failed`, e.message); } // a part that cannot be worked out is left out
  }));
  // keep the keys in a steady order
  return Object.fromEntries(['month', 'monthLabel', ...Object.keys(parts)].filter((k) => out[k] !== undefined).map((k) => [k, out[k]]));
}

module.exports = { get };
