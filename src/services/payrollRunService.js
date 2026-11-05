// The payroll (service PAYROLL_SALARY to change, any payroll service to read).
//   A payroll (run) is one CLASS (group) for one MONTH: "Create Payroll" makes a payslip for every confirmed employee of the group who worked in the month, copying the policy of that
//   month onto the payroll (so a later policy never changes it) and the month's attendance onto each payslip.
//   The payslip holds the month's attendance as a COPY: HR may change a day on the slip (Draft / Review only); "Get attendance" copies the attendance module's days in again and the
//   changes are gone. The amounts come from utils/payrollEngine (pure, exact); this file only gathers the inputs, saves the answer and moves the payslip along:
//     DRAFT -> REVIEW (HR) -> FINAL_REVIEW -> APPROVED (the reviewers: a client admin or a chosen approver); SUSPENDED = left out of this payroll for now, with a note, and can be resumed.
//   Approving posts the accounting entry of the payslip and takes the loan instalments; sending it back to Draft (while nothing is paid) reverses both.
//   The salary is paid by a Salary Payment Voucher (salaryPaymentVoucherService); `paidAmount` follows its confirmed vouchers.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { calculate, rupees } = require('../utils/payrollEngine');
const { schedule } = require('../utils/loanSchedule');
const { earnedLeave, datesBetween } = require('../utils/leaveBalance');
const { WEEKDAYS, dayIndex } = require('../utils/attendanceEngine');
const accountService = require('./accountService');
const audit = require('./auditService');
const journal = require('./journalService');
const policyService = require('./payrollPolicyService');
const attendance = require('./payrollAttendanceService');
const { isApprover } = require('./payrollApproverService');
const eobiService = require('./eobiService');
const incomeTax = require('./incomeTaxService');
const incrementService = require('./payrollIncrementService');

const { toCents, fromCents } = accountService.internals;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const lock = (name, companyId, transaction) => sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `${name}:${companyId}` }, transaction });
const pad4 = (n) => String(n).padStart(4, '0');
const pad5 = (n) => String(n).padStart(5, '0');
const money = (c) => fromCents(c);
const NIL = '00000000-0000-0000-0000-000000000000';
const SOURCE = 'PAYROLL_SLIP';
const DAY_CODES = ['P', 'L', 'HD', 'A', 'R', 'AL'];
const STATUS = {
  DRAFT: { code: 0, text: 'Draft' }, REVIEW: { code: 1, text: 'Review' }, FINAL_REVIEW: { code: 2, text: 'Final review' }, APPROVED: { code: 3, text: 'Approved' }, SUSPENDED: { code: 9, text: 'Suspended' },
};
const EDITABLE = ['DRAFT', 'REVIEW']; // the slip's inputs and days can be changed only here
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const POLICY_FIELDS = policyService.FIELDS;

/** An amount typed by HR (a number or text) as text with 2 decimals. */
const amt = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v).trim());
const roundRupee = (c) => ((c + 50n) / 100n) * 100n;
const pct = (cents, percent) => (percent == null ? 0n : (cents * BigInt(Math.round(Number(percent) * 100)) + 5000n) / 10000n);
const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]}-${month.slice(2, 4)}`;
const monthCode = (month) => `${month.slice(5, 7)}${month.slice(0, 4)}`;

function monthInfo(month) {
  const [y, m] = month.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const last = `${month}-${String(dim).padStart(2, '0')}`;
  return { first, last, dim };
}
const dayName = (ymd) => WEEKDAYS[new Date(dayIndex(ymd) * 86400000).getUTCDay()];
const cap = (d) => d[0] + d.slice(1, 3).toLowerCase();

// ---- the engine's inputs and the result written back ----

/** Every number of the payslip from its state: counts from the days, then the engine. `state` holds cents (BigInt) and plain numbers. */
function finish(state, policy) {
  const counts = { P: 0, L: 0, HD: 0, A: 0, R: 0, AL: 0 };
  let otAuto = 0;
  let restWorked = 0;
  for (const d of state.days) {
    if (counts[d.code] !== undefined) counts[d.code] += 1;
    if (['P', 'L', 'HD', 'R'].includes(d.code)) otAuto += d.overtimeMinutes;
    if (d.code === 'R' && d.workedMinutes > 0) restWorked += 1;
  }
  const overtimeMinutes = state.overtimeManualMinutes != null ? state.overtimeManualMinutes : otAuto;
  const dutyMinutes = Math.round(state.dutyHours * 60);
  // food and maintenance are paid pro-rata on the days worked (P + L + HD + R), never more than the full amount; a fixed salary gets them in full; a figure typed by HR stays
  let food = state.food;
  let maint = state.maintenance;
  if (state.foodFull != null && state.salaryType !== 'FIXED') {
    const worked = BigInt(counts.P + counts.L + counts.HD + counts.R);
    const dimB = BigInt(state.daysInMonth);
    const share = (full) => { const v = rupees(full * worked, dimB); return v > full ? full : v; };
    if (!state.overrides.includes('food')) food = share(state.foodFull);
    if (!state.overrides.includes('maintenance')) maint = share(state.maintFull);
  }
  const input = (eobi, tax) => ({
    salaryType: state.salaryType, basicCents: state.basicCents, daysInMonth: state.daysInMonth, counts, alBalance: state.alBalance, latesPerHalfDay: policy.latesPerHalfDay,
    dutyMinutes, overtimeMinutes, overtimeFactor: Number(policy.overtimeFactor),
    additions: { food, maintenance: maint, mobile: state.mobile, others: state.othersAdd },
    deductions: { loan: state.loan, advance: state.advance || 0n, eobi, tax, others: state.othersDeduct },
  });
  let eobi = state.eobi;
  let tax = state.tax;
  const auto = (key) => !state.overrides.includes(key);
  if (auto('eobi') || auto('tax')) {
    // EOBI and income tax are a percent of the basic (of the basic earned for a daily wage)
    const probe = calculate(input(0n, 0n));
    const base = state.salaryType === 'DAILY' ? probe.earned : state.basicCents;
    // the employee share of the EOBI list of the month when he is on one, else the percent of his card
    if (auto('eobi')) eobi = state.eobiFixed != null ? state.eobiFixed : roundRupee(pct(base, state.eobiPercent));
    // a fixed monthly amount of the employee's income tax history wins over a percent
    if (auto('tax')) tax = state.taxFixed != null ? state.taxFixed : roundRupee(pct(base, state.taxPercent));
  }
  const r = calculate(input(eobi, tax));
  const dim = BigInt(state.daysInMonth);
  const daily = state.salaryType === 'DAILY' ? state.basicCents : state.basicCents / dim;
  const dailyExact = state.salaryType === 'DAILY' ? Number(state.basicCents) / 100 : Number(state.basicCents) / 100 / state.daysInMonth;
  return {
    counts, restWorked, eobi, tax, r,
    columns: {
      cntP: counts.P, cntL: counts.L, cntHD: counts.HD, cntA: counts.A, cntR: counts.R, cntAL: counts.AL, payableDays: r.payableDays, lateDeductionDays: r.lateDeductionDays, alPaid: r.alPaid,
      alBalance: state.alBalance, overtimeMinutes, grossAmount: money(r.gross), additionsAmount: money(r.additions), deductionsAmount: money(r.deductions), contributionAmount: money(r.contribution),
      netAmount: money(r.net), eobiAmount: money(eobi), taxAmount: money(tax), foodAmount: money(food), maintenanceAmount: money(maint),
    },
    calc: {
      dailyRate: dailyExact.toFixed(5), dailyRateCents: String(daily), hourlyRate: state.dutyHours > 0 ? (dailyExact / state.dutyHours).toFixed(5) : null, overtimeDays: r.overtimeDays,
      overtimeFactor: r.overtimeFactor, overtimeAmount: money(r.overtime), earned: money(r.earned), alUnpaid: r.alUnpaid, halfDayDays: r.halfDayDays, absentDays: c0(counts.A), restWorked,
      contribution: { late: money(r.contributionParts.late), halfDay: money(r.contributionParts.halfDay), penalty: money(r.contributionParts.penalty) },
      eobiPercent: state.eobiPercent, taxPercent: state.taxPercent, foodFull: state.foodFull == null ? null : String(state.foodFull), maintFull: state.maintFull == null ? null : String(state.maintFull), eobiFixed: state.eobiFixed == null ? null : String(state.eobiFixed), taxFixed: state.taxFixed == null ? null : String(state.taxFixed), overrides: state.overrides, overtimeAuto: otAuto,
    },
  };
}
const c0 = (n) => Number(n);

/** The state of a stored payslip (the row and its days) for `finish`. */
function stateOf(s, days, loanTotal, advanceTotal = 0n) {
  const calc = s.calc || {};
  return {
    salaryType: s.salaryType, basicCents: toCents(s.basicSalary), daysInMonth: s.daysInMonth, dutyHours: Number(s.dutyHours), alBalance: Number(s.alBalance),
    food: toCents(s.foodAmount), maintenance: toCents(s.maintenanceAmount), mobile: toCents(s.mobileAmount), othersAdd: toCents(s.othersAddAmount),
    eobi: toCents(s.eobiAmount), tax: toCents(s.taxAmount), othersDeduct: toCents(s.othersDeductAmount), loan: loanTotal, advance: advanceTotal,
    overtimeManualMinutes: s.overtimeMinutesManual, eobiPercent: calc.eobiPercent == null ? null : calc.eobiPercent, taxPercent: calc.taxPercent == null ? null : calc.taxPercent,
    foodFull: calc.foodFull == null ? null : BigInt(calc.foodFull), maintFull: calc.maintFull == null ? null : BigInt(calc.maintFull),
    eobiFixed: calc.eobiFixed == null ? null : BigInt(calc.eobiFixed), taxFixed: calc.taxFixed == null ? null : BigInt(calc.taxFixed),
    overrides: calc.overrides || [], days: days.map((d) => ({ code: d.code, overtimeMinutes: d.overtimeMinutes, workedMinutes: d.workedMinutes })),
  };
}

async function save(slipId, out, extra, transaction) {
  const cols = { ...out.columns, ...extra };
  const keys = Object.keys(cols);
  await run(`UPDATE payroll_slips SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, calc = CAST(:calc AS jsonb), "calculatedAt" = now(), "updatedAt" = now() WHERE id = :id`,
    { id: slipId, calc: JSON.stringify(out.calc), ...cols }, transaction);
}

// ---- the attendance and the loans and the leave balance, gathered for many employees at once ----

async function attendanceDays(companyId, employeeIds, first, last, transaction) {
  if (!employeeIds.length) return new Map();
  const rows = await q(`SELECT d."employeeId", to_char(d."workDate", 'YYYY-MM-DD') AS date, d.code, d."firstIn", d."lastOut", d."workedMinutes", d."lateMinutes", d."overtimeMinutes", d."restDay"
    FROM payroll_attendance_days d WHERE d."companyId" = :companyId AND d."employeeId" IN (:employeeIds) AND d."workDate" BETWEEN :first AND :last ORDER BY d."workDate"`, { companyId, employeeIds, first, last }, transaction);
  const out = new Map(employeeIds.map((id) => [id, new Map()]));
  for (const r of rows) out.get(r.employeeId).set(r.date, r);
  return out;
}

/** The days of one employee for the payslip: one per date of his employment in the month, the attendance's day or "-" (no data). */
function daysFor(emp, byDate, first, last, until) {
  const from = emp.joined > first ? emp.joined : first;
  const to = emp.leftOn && emp.leftOn < last ? emp.leftOn : last;
  if (from > to) return [];
  return datesBetween(from, to).map((date) => {
    const a = byDate.get(date);
    if (a) return { date, code: a.code, originalCode: a.code, firstIn: a.firstIn, lastOut: a.lastOut, workedMinutes: a.workedMinutes, overtimeMinutes: a.overtimeMinutes, lateMinutes: a.lateMinutes, restDay: a.restDay, edited: false };
    return { date, code: '-', originalCode: '-', firstIn: null, lastOut: null, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0, restDay: false, edited: false, future: date > until };
  });
}

/** Late and half day follow the limits of the payroll (a day of work that the attendance calls P, L or HD is judged again from the minutes late). Edited days are left alone. */
function recode(days, policy) {
  return days.map((d) => {
    if (d.edited || d.restDay || !['P', 'L', 'HD'].includes(d.originalCode)) return d;
    const code = d.lateMinutes <= policy.lateLimitMinutes ? 'P' : d.lateMinutes <= policy.halfDayLimitMinutes ? 'L' : 'HD';
    return { ...d, code };
  });
}

/** The instalments due for the month: what the schedule asks up to this month and has not been taken yet, never more than what the employee still owes. */
async function loanDues(companyId, employeeIds, month, transaction) {
  const out = new Map(employeeIds.map((id) => [id, []]));
  if (!employeeIds.length) return out;
  const rows = await q(`SELECT l.id, l.code, l."employeeId", l."approvedAmount"::text AS approved, l.months, to_char(l."deductFrom", 'YYYY-MM') AS "deductFrom",
      COALESCE((SELECT SUM(v.amount) FROM employee_loan_vouchers v WHERE v."loanId" = l.id AND v.status = 'CONFIRMED'), 0)::text AS paid,
      COALESCE((SELECT SUM(x.amount) FROM payroll_loan_deductions x WHERE x."loanId" = l.id), 0)::text AS deducted
    FROM payroll_loans l WHERE l."companyId" = :companyId AND l.status = 'APPROVED' AND l."employeeId" IN (:employeeIds) AND to_char(l."deductFrom", 'YYYY-MM') <= :month ORDER BY l.code`, { companyId, employeeIds, month }, transaction);
  for (const l of rows) {
    const plan = schedule(toCents(l.approved), l.months, l.deductFrom);
    const asked = plan.filter((p) => p.month <= month).reduce((t, p) => t + p.cents, 0n);
    const balance = toCents(l.paid) - toCents(l.deducted);
    const due = asked - toCents(l.deducted) > 0n ? asked - toCents(l.deducted) : 0n;
    const amount = balance > 0n ? (due < balance ? due : balance) : 0n;
    if (balance > 0n || due > 0n) out.get(l.employeeId).push({ loanId: l.id, appId: pad5(l.code), due, amount, balance: balance > 0n ? balance : 0n });
  }
  return out;
}

/** The advances due for the month: every advance dated up to that month whose voucher is confirmed (the money was paid out) and that the payroll has not taken yet, in full. */
async function advanceDues(companyId, employeeIds, month, transaction) {
  const out = new Map(employeeIds.map((id) => [id, []]));
  if (!employeeIds.length) return out;
  const rows = await q(`SELECT a.id, a.code, a."employeeId", a.amount::text AS amount, COALESCE((SELECT SUM(x.amount) FROM payroll_advance_deductions x WHERE x."advanceId" = a.id), 0)::text AS deducted
    FROM payroll_advances a WHERE a."companyId" = :companyId AND a."employeeId" IN (:employeeIds) AND to_char(a."advanceDate", 'YYYY-MM') <= :month
      AND EXISTS (SELECT 1 FROM employee_advance_vouchers v WHERE v."advanceId" = a.id AND v.status = 'CONFIRMED') ORDER BY a.code`, { companyId, employeeIds, month }, transaction);
  for (const a of rows) {
    const left = toCents(a.amount) - toCents(a.deducted);
    if (left > 0n) out.get(a.employeeId).push({ advanceId: a.id, code: a.code, due: left, amount: left });
  }
  return out;
}

/** Annual leave a payslip can still pay on the first day of the month: earned up to then less what approved leave took before the month. */
async function leaveBalances(companyId, emps, groupId, month, firstDay, runPolicy, transaction) {
  const out = new Map();
  if (!emps.length) return out;
  const earliest = emps.reduce((m, e) => (e.joined.slice(0, 7) < m ? e.joined.slice(0, 7) : m), month);
  const cache = new Map();
  for (let m = earliest; m < month; m = nextMonth(m)) cache.set(m, await policyService.effectivePolicy(companyId, groupId, m, transaction));
  const policyFor = (m) => (m >= month ? runPolicy : cache.get(m));
  const taken = await q(`SELECT d."employeeId", count(*)::int AS n FROM payroll_leave_days d JOIN payroll_leaves l ON l.id = d."leaveId"
    WHERE d."companyId" = :companyId AND l.status = 'APPROVED' AND d."leaveDate" < :firstDay AND d."employeeId" IN (:ids) GROUP BY d."employeeId"`, { companyId, firstDay, ids: emps.map((e) => e.id) }, transaction);
  const takenBy = new Map(taken.map((t) => [t.employeeId, t.n]));
  for (const e of emps) {
    const { earned } = earnedLeave({ joiningDate: e.joined, leavingDate: e.leftOn, asOf: firstDay, policyFor });
    out.set(e.id, Math.max(0, Math.round((earned - (takenBy.get(e.id) || 0)) * 100) / 100));
  }
  return out;
}
const nextMonth = (month) => { const [y, m] = month.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

const runPolicyOf = (r) => ({
  lateLimitMinutes: r.lateLimitMinutes, halfDayLimitMinutes: r.halfDayLimitMinutes, latesPerHalfDay: r.latesPerHalfDay, weeklyOffDay: r.weeklyOffDay, overtimeFactor: Number(r.overtimeFactor),
  leaveEarnedPerMonth: Number(r.leaveEarnedPerMonth), maxLeavePerYear: Number(r.maxLeavePerYear), monthsBeforeLeave: r.monthsBeforeLeave,
});

// ---- making the payslips of a payroll ----

const EMPLOYEE_SELECT = `e.id, e.code, e.name, e."salaryType", e."basicSalary"::text AS basic, e."foodAllowance"::text AS food, e."maintenanceAllowance"::text AS maint, e."mobileAllowance"::text AS mobile,
  e."paymentMethod", e."accountNo", e."accountTitle", b.name AS "bankName",
  d.name AS "departmentName", ds.name AS "designationName", sh.code AS "shiftCode", to_char(sh."startTime", 'HH24:MI') AS "shiftStart", to_char(sh."endTime", 'HH24:MI') AS "shiftEnd", sh."dutyHours"::float AS "dutyHours",
  to_char(e."joiningDate", 'YYYY-MM-DD') AS joined, to_char(e."leavingDate", 'YYYY-MM-DD') AS "leftOn", e."isClosed", e."groupId"`;
const EMPLOYEE_FROM = `payroll_employees e LEFT JOIN payroll_banks b ON b.id = e."bankId" LEFT JOIN payroll_departments d ON d.id = e."departmentId"
  LEFT JOIN payroll_designations ds ON ds.id = e."designationId" LEFT JOIN payroll_shifts sh ON sh.id = e."shiftId"`;

/** Adds the payslips of the employees who have none yet (all of them for a new payroll). Returns how many were made. */
async function addEmployees(req, r, transaction, onlyIds = null) {
  const { companyId } = req.user;
  const { first, last, dim } = monthInfo(r.month);
  const repl = { companyId, groupId: r.groupId, first, last, runId: r.id };
  let extra = '';
  if (onlyIds) { extra = ' AND e.id IN (:onlyIds)'; repl.onlyIds = onlyIds; }
  const emps = await q(`SELECT ${EMPLOYEE_SELECT} FROM ${EMPLOYEE_FROM} WHERE e."companyId" = :companyId AND e."groupId" = :groupId AND e.status = 'CONFIRMED' AND e."joiningDate" <= :last
    AND (NOT e."isClosed" OR e."leavingDate" >= :first) AND NOT EXISTS (SELECT 1 FROM payroll_slips s WHERE s."runId" = :runId AND s."employeeId" = e.id)${extra} ORDER BY e.code`, repl, transaction);
  if (!emps.length) return 0;
  const ids = emps.map((e) => e.id);
  const until = today();
  const stop = last < until ? last : until;
  if (first <= stop) await attendance.processRange(companyId, { from: first, to: stop, employeeIds: ids }, transaction);
  const att = await attendanceDays(companyId, ids, first, last, transaction);
  const loans = await loanDues(companyId, ids, r.month.slice(0, 7), transaction);
  const advDues = await advanceDues(companyId, ids, r.month.slice(0, 7), transaction);
  const policy = runPolicyOf(r);
  const alBy = await leaveBalances(companyId, emps, r.groupId, r.month.slice(0, 7), first, policy, transaction);
  const eobiBy = await eobiService.eobiShares(companyId, ids, r.month, transaction);
  // an increment posted since, which applies from a LATER month, must not change this month: the figures the employee had then
  const asOf = await incrementService.salaryAsOf(companyId, ids, r.month, transaction);
  for (const e of emps) { const o = asOf.get(e.id); if (o) Object.assign(e, o); }
  const taxBy = await incomeTax.settingsFor(companyId, ids, r.month.slice(0, 7), transaction);
  await lock('payroll-slip', companyId, transaction);
  let code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_slips WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0);
  for (const e of emps) {
    code += 1;
    const days = recode(daysFor(e, att.get(e.id), first, last, until), policy);
    const dues = loans.get(e.id);
    const advs = advDues.get(e.id);
    const state = {
      salaryType: e.salaryType, basicCents: toCents(e.basic), daysInMonth: dim, dutyHours: e.dutyHours || 0, alBalance: alBy.get(e.id) || 0, food: toCents(e.food), foodFull: toCents(e.food), maintFull: toCents(e.maint), maintenance: toCents(e.maint),
      mobile: toCents(e.mobile), othersAdd: 0n, eobi: 0n, tax: 0n, othersDeduct: 0n, loan: dues.reduce((t, d) => t + d.amount, 0n), advance: advs.reduce((t, d) => t + d.amount, 0n), overtimeManualMinutes: null,
      eobiPercent: null, taxPercent: taxBy.has(e.id) ? taxBy.get(e.id).percent : null, taxFixed: taxBy.has(e.id) ? taxBy.get(e.id).fixed : null, eobiFixed: eobiBy.has(e.id) ? eobiBy.get(e.id) : null, overrides: [], days,
    };
    const out = finish(state, policy);
    const [row] = await q(`INSERT INTO payroll_slips ("companyId", "runId", code, "employeeId", status, "empCode", "empName", "departmentName", "designationName", "shiftLabel", "dutyHours", "joiningDate", "leavingDate",
        "bankName", "accountNo", "accountTitle", "paymentMethod", "salaryType", "basicSalary", "foodAmount", "maintenanceAmount", "mobileAmount")
      VALUES (:companyId, :runId, :code, :employeeId, 'DRAFT', :empCode, :empName, :department, :designation, :shift, :dutyHours, :joined, :leftOn, :bankName, :accountNo, :accountTitle, :method, :salaryType, :basic, :food, :maint, :mobile)
      RETURNING id`, {
      companyId, runId: r.id, code, employeeId: e.id, empCode: e.code, empName: e.name, department: e.departmentName, designation: e.designationName,
      shift: e.shiftCode ? `${e.shiftCode} (${e.shiftStart}-${e.shiftEnd}, ${e.dutyHours} hrs)` : null, dutyHours: e.dutyHours || 0, joined: e.joined, leftOn: e.isClosed ? e.leftOn : null,
      bankName: e.bankName, accountNo: e.accountNo, accountTitle: e.accountTitle, method: e.paymentMethod, salaryType: e.salaryType, basic: e.basic, food: e.food, maint: e.maint, mobile: e.mobile,
    }, transaction);
    await save(row.id, out, { loanAmount: money(state.loan), advanceAmount: money(state.advance) }, transaction);
    await writeDays(row.id, days, transaction);
    for (const d of advs) await run('INSERT INTO payroll_slip_advances ("slipId", "companyId", "advanceId", due, amount) VALUES (:slipId, :companyId, :advanceId, :due, :amount)',
      { slipId: row.id, companyId, advanceId: d.advanceId, due: money(d.due), amount: money(d.amount) }, transaction);
    for (const d of dues) await run('INSERT INTO payroll_slip_loans ("slipId", "companyId", "loanId", due, amount, "balanceBefore") VALUES (:slipId, :companyId, :loanId, :due, :amount, :balance)',
      { slipId: row.id, companyId, loanId: d.loanId, due: money(d.due), amount: money(d.amount), balance: money(d.balance) }, transaction);
  }
  return emps.length;
}

async function writeDays(slipId, days, transaction) {
  await run('DELETE FROM payroll_slip_days WHERE "slipId" = :slipId', { slipId }, transaction);
  for (let i = 0; i < days.length; i += 500) {
    const chunk = days.slice(i, i + 500).map((d) => ({ dayDate: d.date, code: d.code, originalCode: d.originalCode, firstIn: d.firstIn ? new Date(d.firstIn).toISOString() : null,
      lastOut: d.lastOut ? new Date(d.lastOut).toISOString() : null, workedMinutes: d.workedMinutes, overtimeMinutes: d.overtimeMinutes, lateMinutes: d.lateMinutes, restDay: d.restDay, edited: d.edited }));
    await run(`INSERT INTO payroll_slip_days ("slipId", "dayDate", code, "originalCode", "firstIn", "lastOut", "workedMinutes", "overtimeMinutes", "lateMinutes", "restDay", edited)
      SELECT CAST(:slipId AS uuid), x."dayDate", x.code, x."originalCode", x."firstIn", x."lastOut", x."workedMinutes", x."overtimeMinutes", x."lateMinutes", x."restDay", x.edited
      FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x("dayDate" date, code text, "originalCode" text, "firstIn" timestamptz, "lastOut" timestamptz, "workedMinutes" int, "overtimeMinutes" int, "lateMinutes" int, "restDay" boolean, edited boolean)`,
    { slipId, rows: JSON.stringify(chunk) }, transaction);
  }
}

// ---- reading ----

const RUN_SELECT = `r.id, r.code, r."groupId", g.name AS "groupName", to_char(r.month, 'YYYY-MM') AS month, r.category, r."daysInMonth", r."lateLimitMinutes", r."halfDayLimitMinutes", r."latesPerHalfDay",
  r."weeklyOffDay", r."overtimeFactor"::float AS "overtimeFactor", r."leaveEarnedPerMonth"::float AS "leaveEarnedPerMonth", r."maxLeavePerYear"::float AS "maxLeavePerYear", r."monthsBeforeLeave", r."policySource", r."createdAt", r."updatedAt"`;
const RUN_FROM = 'payroll_runs r JOIN payroll_groups g ON g.id = r."groupId"';
const STAT = `count(*)::int AS slips, count(*) FILTER (WHERE s.status = 'DRAFT')::int AS draft, count(*) FILTER (WHERE s.status = 'REVIEW')::int AS review,
  count(*) FILTER (WHERE s.status = 'FINAL_REVIEW')::int AS "finalReview", count(*) FILTER (WHERE s.status = 'APPROVED')::int AS approved, count(*) FILTER (WHERE s.status = 'SUSPENDED')::int AS suspended,
  count(*) FILTER (WHERE s.status <> 'SUSPENDED')::int AS employees, COALESCE(SUM(s."basicSalary") FILTER (WHERE s.status <> 'SUSPENDED'), 0)::text AS basic,
  COALESCE(SUM(s."grossAmount") FILTER (WHERE s.status <> 'SUSPENDED'), 0)::text AS gross, COALESCE(SUM(s."netAmount") FILTER (WHERE s.status <> 'SUSPENDED'), 0)::text AS net,
  COALESCE(SUM(s."netAmount") FILTER (WHERE s.status = 'APPROVED'), 0)::text AS "netApproved", COALESCE(SUM(s."paidAmount") FILTER (WHERE s.status = 'APPROVED'), 0)::text AS paid,
  COALESCE(SUM(s."contributionAmount") FILTER (WHERE s.status <> 'SUSPENDED'), 0)::text AS contribution,
  COALESCE(SUM(s."netAmount") FILTER (WHERE s.status = 'APPROVED' AND s."paymentMethod" = 'BANK' AND NOT s."isCash"), 0)::text AS "netBank",
  count(*) FILTER (WHERE s.status = 'APPROVED' AND s."paymentMethod" = 'BANK' AND NOT s."isCash")::int AS "bankSlips", count(*) FILTER (WHERE s."bankFileId" IS NOT NULL)::int AS "inBankFile"`;

function statsJson(t) {
  const approved = toCents(t.netApproved);
  const paid = toCents(t.paid);
  return {
    counts: { total: t.slips, draft: t.draft, review: t.review, finalReview: t.finalReview, approved: t.approved, suspended: t.suspended },
    totals: { employees: t.employees, basic: money(toCents(t.basic)), gross: money(toCents(t.gross)), net: money(toCents(t.net)), netApproved: money(approved), paid: money(paid), balance: money(approved - paid), contribution: money(toCents(t.contribution)) },
  };
}

function runJson(r, stats) {
  const policy = runPolicyOf(r);
  return {
    id: r.id, code: r.code, label: `Payroll #${r.code}`, group: { id: r.groupId, name: r.groupName }, month: r.month, monthCode: monthCode(r.month), monthLabel: monthLabel(r.month), category: r.category,
    daysInMonth: r.daysInMonth, policy: { ...policy, summary: policyService.summary(policy) }, policySource: r.policySource, ...(stats ? statsJson(stats) : {}), createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function loadRun(companyId, id, transaction) {
  const [r] = await q(`SELECT ${RUN_SELECT} FROM ${RUN_FROM} WHERE r.id = :id AND r."companyId" = :companyId`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Payroll');
  return r;
}

async function runStats(runId, transaction) {
  const [t] = await q(`SELECT ${STAT} FROM payroll_slips s WHERE s."runId" = :runId`, { runId }, transaction);
  return t;
}

async function getRun(req, id, transaction) {
  const r = await loadRun(req.user.companyId, id, transaction);
  const out = runJson(r, await runStats(id, transaction));
  out.canDelete = out.counts.approved === 0;
  // the "bank file made" side of the run: how many approved bank payslips are in a file, and the latest file
  const [last] = await q('SELECT id, code, "fileName", employees, total::text AS total, "createdAt" FROM payroll_bank_files WHERE "runId" = :id ORDER BY "createdAt" DESC, code DESC LIMIT 1', { id }, transaction);
  const stats = await runStats(id, transaction);
  out.bankFile = { bankSlips: stats.bankSlips, inFile: stats.inBankFile, last: last ? { id: last.id, code: last.code, label: `BF-${pad5(last.code)}`, fileName: last.fileName, employees: last.employees, total: money(toCents(last.total)), at: last.createdAt } : null };
  return out;
}

/** The payrolls of a month (one per class) with the chips of the Payroll Summary screen. */
async function listRuns(req, { month, search }) {
  const { companyId } = req.user;
  const m = month || today().slice(0, 7);
  const where = ['r."companyId" = :companyId', 'r.month = :first'];
  const repl = { companyId, first: `${m}-01` };
  if (search) {
    repl.like = `%${search}%`;
    const numeric = /^\d+$/.test(search) ? ' OR r.code = :n' : '';
    if (numeric) repl.n = Number(search);
    where.push(`(g.name ILIKE :like${numeric})`);
  }
  const rows = await q(`SELECT ${RUN_SELECT} FROM ${RUN_FROM} WHERE ${where.join(' AND ')} ORDER BY g."sortOrder", lower(g.name)`, repl);
  const data = [];
  let sum = { payrolls: 0, employees: 0, basic: 0n, netApproved: 0n, balance: 0n, contribution: 0n };
  for (const r of rows) {
    const j = runJson(r, await runStats(r.id));
    j.canDelete = j.counts.approved === 0;
    data.push(j);
    sum = { payrolls: sum.payrolls + 1, employees: sum.employees + j.totals.employees, basic: sum.basic + toCents(j.totals.basic), netApproved: sum.netApproved + toCents(j.totals.netApproved),
      balance: sum.balance + toCents(j.totals.balance), contribution: sum.contribution + toCents(j.totals.contribution) };
  }
  return { month: m, monthCode: monthCode(m), monthLabel: monthLabel(m), data, totals: { payrolls: sum.payrolls, employees: sum.employees, basic: money(sum.basic), netApproved: money(sum.netApproved), salaryBalance: money(sum.balance), contribution: money(sum.contribution) } };
}

/** The payrolls of a month with their totals (the Payroll Summary), the stats of all of them in one query. Used by the overview. */
async function runsOfMonth(companyId, month) {
  const first = `${month}-01`;
  const rows = await q(`SELECT ${RUN_SELECT} FROM ${RUN_FROM} WHERE r."companyId" = :companyId AND r.month = :first ORDER BY g."sortOrder", lower(g.name)`, { companyId, first });
  const stats = await q(`SELECT s."runId", ${STAT} FROM payroll_slips s JOIN payroll_runs r ON r.id = s."runId" WHERE r."companyId" = :companyId AND r.month = :first GROUP BY s."runId"`, { companyId, first });
  const by = new Map(stats.map((t) => [t.runId, t]));
  const zero = { slips: 0, draft: 0, review: 0, finalReview: 0, approved: 0, suspended: 0, employees: 0, basic: '0', gross: '0', net: '0', netApproved: '0', paid: '0', contribution: '0', netBank: '0' };
  const data = [];
  let sum = { payrolls: 0, employees: 0, basic: 0n, netApproved: 0n, balance: 0n, contribution: 0n };
  for (const r of rows) {
    const j = runJson(r, by.get(r.id) || zero);
    j.canDelete = j.counts.approved === 0;
    data.push(j);
    sum = { payrolls: sum.payrolls + 1, employees: sum.employees + j.totals.employees, basic: sum.basic + toCents(j.totals.basic), netApproved: sum.netApproved + toCents(j.totals.netApproved),
      balance: sum.balance + toCents(j.totals.balance), contribution: sum.contribution + toCents(j.totals.contribution) };
  }
  return { data, totals: { payrolls: sum.payrolls, employees: sum.employees, basic: money(sum.basic), netApproved: money(sum.netApproved), salaryBalance: money(sum.balance), contribution: money(sum.contribution) } };
}

// ---- making and removing a payroll ----

async function createRun(req, { month, groupId }) {
  const { companyId } = req.user;
  if (month > today().slice(0, 7)) throw AppError.rule('MONTH_IN_FUTURE', 'A payroll cannot be made for a month that has not started');
  const id = await sequelize.transaction(async (transaction) => {
    await lock('payroll-run', companyId, transaction);
    const [g] = await q('SELECT id, name, "isActive" FROM payroll_groups WHERE id = :groupId AND "companyId" = :companyId', { groupId, companyId }, transaction);
    if (!g) throw AppError.notFound('Group');
    if (!g.isActive) throw AppError.rule('GROUP_INACTIVE', `${g.name} is switched off`);
    const [exists] = await q('SELECT code FROM payroll_runs WHERE "companyId" = :companyId AND "groupId" = :groupId AND month = :first', { companyId, groupId, first: `${month}-01` }, transaction);
    if (exists) throw AppError.rule('PAYROLL_EXISTS', `${g.name} already has payroll #${exists.code} for ${monthLabel(month)}`, { code: exists.code });
    const p = await policyService.effectivePolicy(companyId, groupId, month, transaction);
    const code = ((await q('SELECT COALESCE(MAX(code), 0) AS m FROM payroll_runs WHERE "companyId" = :companyId', { companyId }, transaction))[0].m || 0) + 1;
    const [row] = await q(`INSERT INTO payroll_runs ("companyId", code, "groupId", month, "daysInMonth", "lateLimitMinutes", "halfDayLimitMinutes", "latesPerHalfDay", "weeklyOffDay", "overtimeFactor",
        "leaveEarnedPerMonth", "maxLeavePerYear", "monthsBeforeLeave", "policySource", "createdById")
      VALUES (:companyId, :code, :groupId, :first, :dim, :lateLimitMinutes, :halfDayLimitMinutes, :latesPerHalfDay, :weeklyOffDay, :overtimeFactor, :leaveEarnedPerMonth, :maxLeavePerYear, :monthsBeforeLeave, :source, :userId) RETURNING id`,
    { companyId, code, groupId, first: `${month}-01`, dim: monthInfo(month).dim, ...Object.fromEntries(POLICY_FIELDS.map((f) => [f, p[f]])), source: p.source === 'POLICY' ? 'POLICY' : 'DEFAULT', userId: req.user.id }, transaction);
    const r = await loadRun(companyId, row.id, transaction);
    const made = await addEmployees(req, r, transaction);
    if (!made) throw AppError.rule('NO_EMPLOYEES', `${g.name} has no confirmed employee who worked in ${monthLabel(month)}`);
    await audit.log(req, { action: 'PAYROLL_RUN_CREATED', entityType: 'PayrollRun', entityId: row.id, after: { code, group: g.name, month, employees: made } }, { transaction });
    return row.id;
  });
  return getRun(req, id);
}

/** Employees who joined or were confirmed after the payroll was made: gives them their payslip. */
async function addMissing(req, id) {
  const { companyId } = req.user;
  let made = 0;
  await sequelize.transaction(async (transaction) => {
    await lock('payroll-run', companyId, transaction);
    const r = await loadRun(companyId, id, transaction);
    made = await addEmployees(req, r, transaction);
    await audit.log(req, { action: 'PAYROLL_RUN_EMPLOYEES_ADDED', entityType: 'PayrollRun', entityId: id, after: { added: made } }, { transaction });
  });
  return { ...(await getRun(req, id)), added: made };
}

async function removeRun(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    await lock('payroll-run', companyId, transaction);
    const r = await loadRun(companyId, id, transaction);
    const [a] = await q(`SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS approved FROM payroll_slips WHERE "runId" = :id`, { id }, transaction);
    if (a.approved) throw AppError.rule('PAYROLL_HAS_APPROVED', 'A payroll with approved payslips cannot be deleted: send them back to Draft first');
    await run('DELETE FROM payroll_runs WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_RUN_DELETED', entityType: 'PayrollRun', entityId: id, before: { code: r.code, group: r.groupName, month: r.month } }, { transaction });
  });
}

// ---- the policy of a payroll ----

/** The policy modal: changes the policy of THIS payroll (the unapproved payslips are calculated again) and, when asked, makes it the policy of the class from this month on. */
async function setPolicy(req, id, data) {
  const { companyId } = req.user;
  const changes = Object.fromEntries(POLICY_FIELDS.filter((f) => data[f] !== undefined).map((f) => [f, data[f]]));
  await sequelize.transaction(async (transaction) => {
    await lock('payroll-run', companyId, transaction);
    const r = await loadRun(companyId, id, transaction);
    const merged = { ...runPolicyOf(r), ...changes };
    if (!(merged.halfDayLimitMinutes > merged.lateLimitMinutes)) throw AppError.rule('HALF_DAY_NOT_MORE_THAN_LATE', 'The half-day limit must be more than the late limit', { lateLimitMinutes: merged.lateLimitMinutes, halfDayLimitMinutes: merged.halfDayLimitMinutes });
    const cols = Object.keys(changes);
    if (cols.length) {
      await run(`UPDATE payroll_runs SET ${cols.map((c) => `"${c}" = :${c}`).join(', ')}, "policySource" = 'EDITED', "updatedAt" = now() WHERE id = :id`, { id, ...changes }, transaction);
      const fresh = await loadRun(companyId, id, transaction);
      await recalcRun(req, fresh, transaction);
    }
    await audit.log(req, { action: 'PAYROLL_RUN_POLICY_CHANGED', entityType: 'PayrollRun', entityId: id, before: runPolicyOf(r), after: merged }, { transaction });
  });
  if (data.makeDefault) {
    const r = await loadRun(companyId, id);
    const values = runPolicyOf(r);
    try {
      await policyService.create(req, { groupId: r.groupId, effectiveFrom: r.month, ...values });
    } catch (e) {
      if (e.code !== 'POLICY_EXISTS') throw e;
      const [v] = (await policyService.list(req, { groupId: r.groupId })).data.filter((p) => p.effectiveFrom === r.month);
      await policyService.update(req, v.id, values);
    }
  }
  return getRun(req, id);
}

/** Calculates every unapproved, unsuspended payslip of a payroll again from what it holds (a changed policy: the late and half-day days are judged again). */
async function recalcRun(req, r, transaction) {
  const slips = await q(`SELECT ${SLIP_SELECT} FROM ${SLIP_FROM} WHERE s."runId" = :id AND s.status IN ('DRAFT', 'REVIEW', 'FINAL_REVIEW')`, { id: r.id }, transaction);
  const policy = runPolicyOf(r);
  for (const s of slips) await recalcSlip(req, s, r, policy, transaction, { recodeDays: true });
}

async function slipDays(slipId, transaction) {
  return q(`SELECT to_char("dayDate", 'YYYY-MM-DD') AS date, code, "originalCode", "firstIn", "lastOut", "workedMinutes", "overtimeMinutes", "lateMinutes", "restDay", edited FROM payroll_slip_days WHERE "slipId" = :slipId ORDER BY "dayDate"`, { slipId }, transaction);
}
async function slipAdvanceRows(slipId, transaction) {
  return q(`SELECT sa.id, sa."advanceId", a.code AS "advanceCode", to_char(a."advanceDate", 'YYYY-MM-DD') AS "advanceDate", sa.due::text AS due, sa.amount::text AS amount, a.amount::text AS "advanceAmount"
    FROM payroll_slip_advances sa JOIN payroll_advances a ON a.id = sa."advanceId" WHERE sa."slipId" = :slipId ORDER BY a.code`, { slipId }, transaction);
}

async function slipLoanRows(slipId, transaction) {
  return q(`SELECT sl.id, sl."loanId", l.code AS "loanCode", sl.due::text AS due, sl.amount::text AS amount, sl."balanceBefore"::text AS "balanceBefore", l."approvedAmount"::text AS approved, l.months, to_char(l."deductFrom", 'YYYY-MM') AS "deductFrom"
    FROM payroll_slip_loans sl JOIN payroll_loans l ON l.id = sl."loanId" WHERE sl."slipId" = :slipId ORDER BY l.code`, { slipId }, transaction);
}

/** The employee share of the month's EOBI list goes into the payslip's calc (the list may have been made or changed after the payroll). Returns the row with the new calc. */
async function refreshEobi(companyId, s, transaction) {
  const share = (await eobiService.eobiShares(companyId, [s.employeeId], s.month, transaction)).get(s.employeeId);
  // the income tax too: the employee's tax history for the month (a fixed amount or a percent), else the fixed monthly tax of his card
  const tax = (await incomeTax.settingsFor(companyId, [s.employeeId], s.month, transaction)).get(s.employeeId);
  const calc = { ...(s.calc || {}), eobiFixed: share == null ? null : String(share), taxFixed: tax && tax.fixed != null ? String(tax.fixed) : null, taxPercent: tax ? tax.percent : null };
  await run('UPDATE payroll_slips SET calc = CAST(:calc AS jsonb) WHERE id = :id', { id: s.id, calc: JSON.stringify(calc) }, transaction);
  return { ...s, calc };
}

/** Works the payslip out again and saves it. `s` is the stored row. */
async function recalcSlip(req, s, r, policy, transaction, { recodeDays = false, days = null } = {}) {
  let rows = days || (await slipDays(s.id, transaction));
  if (recodeDays) {
    rows = recode(rows, policy);
    await writeDays(s.id, rows.map((d) => ({ ...d, date: d.date })), transaction);
  }
  const loans = await slipLoanRows(s.id, transaction);
  const loanTotal = loans.reduce((t, l) => t + toCents(l.amount), 0n);
  const advanceTotal = (await slipAdvanceRows(s.id, transaction)).reduce((t, a) => t + toCents(a.amount), 0n);
  const out = finish(stateOf(s, rows, loanTotal, advanceTotal), policy);
  await save(s.id, out, { loanAmount: money(loanTotal), advanceAmount: money(advanceTotal) }, transaction);
  return out;
}

// ---- the sheet of a payroll and one payslip ----

const SLIP_SELECT = `s.*, to_char(s."joiningDate", 'YYYY-MM-DD') AS joined, to_char(s."leavingDate", 'YYYY-MM-DD') AS "leftOn", e."isClosed" AS "employeeClosed", e."departmentId",
  to_char(r.month, 'YYYY-MM') AS month, r.code AS "runCode", r."groupId", r."daysInMonth" AS "daysInMonth", bf.code AS "bankFileCode", bf."createdAt" AS "bankFileAt"`;
const SLIP_FROM = 'payroll_slips s JOIN payroll_runs r ON r.id = s."runId" JOIN payroll_employees e ON e.id = s."employeeId" LEFT JOIN payroll_bank_files bf ON bf.id = s."bankFileId"';

function slipJson(s, approver = false) {
  const net = toCents(s.netAmount);
  const paid = toCents(s.paidAmount);
  const st = STATUS[s.status];
  const method = s.isCash || s.paymentMethod === 'CASH' ? 'CASH' : 'BANK';
  const calc = s.calc || {};
  const editable = EDITABLE.includes(s.status);
  return {
    id: s.id, code: s.code, payslipId: s.code, runId: s.runId, runCode: s.runCode, month: s.month, status: s.status, statusCode: st.code, statusText: st.text,
    employee: { id: s.employeeId, code: s.empCode, label: pad5(s.empCode), name: s.empName, department: s.departmentName, designation: s.designationName, joiningDate: s.joined, leavingDate: s.leftOn, isLeft: Boolean(s.leftOn) || s.employeeClosed },
    shift: s.shiftLabel, dutyHours: Number(s.dutyHours), salaryType: s.salaryType, basicSalary: money(toCents(s.basicSalary)),
    days: { P: s.cntP, L: s.cntL, HD: s.cntHD, A: s.cntA, R: s.cntR, AL: s.cntAL, total: s.cntP + s.cntL + s.cntHD + s.cntA + s.cntR + s.cntAL },
    alBalance: Number(s.alBalance), alPaid: Number(s.alPaid), lateDeductionDays: Number(s.lateDeductionDays), halfDayDeduction: s.cntHD / 2, absentDays: s.cntA, restWorked: calc.restWorked || 0,
    payableDays: Number(s.payableDays), netDays: Number(s.payableDays), overtimeMinutes: s.overtimeMinutes, overtimeHours: Math.round((s.overtimeMinutes / 60) * 100) / 100,
    overtimeManualHours: s.overtimeMinutesManual == null ? null : Math.round((s.overtimeMinutesManual / 60) * 100) / 100,
    additions: { foodFull: calc.foodFull == null ? null : money(BigInt(calc.foodFull)), maintenanceFull: calc.maintFull == null ? null : money(BigInt(calc.maintFull)), food: money(toCents(s.foodAmount)), maintenance: money(toCents(s.maintenanceAmount)), mobile: money(toCents(s.mobileAmount)), others: money(toCents(s.othersAddAmount)), total: money(toCents(s.additionsAmount)) },
    deductions: { loan: money(toCents(s.loanAmount)), advance: money(toCents(s.advanceAmount)), eobi: money(toCents(s.eobiAmount)), incomeTax: money(toCents(s.taxAmount)), others: money(toCents(s.othersDeductAmount)), total: money(toCents(s.deductionsAmount)) },
    gross: money(toCents(s.grossAmount)), contribution: money(toCents(s.contributionAmount)), net: money(net), paid: money(paid), balance: money(net - paid),
    paymentStatus: paid <= 0n ? 'UNPAID' : paid >= net ? 'PAID' : 'PARTIAL', hasAccount: s.paymentMethod === 'BANK' && Boolean(s.accountNo), isCash: s.isCash, paymentMethod: method,
    bank: { name: s.bankName, accountNo: s.accountNo, accountTitle: s.accountTitle }, notes: s.notes, suspendNote: s.suspendNote, daysEdited: s.daysEdited, overrides: calc.overrides || [],
    taxSource: (calc.overrides || []).includes('tax') ? 'MANUAL' : calc.taxFixed != null ? 'AMOUNT' : calc.taxPercent ? 'PERCENT' : 'NONE',
    eobiSource: (calc.overrides || []).includes('eobi') ? 'MANUAL' : calc.eobiFixed != null ? 'LIST' : calc.eobiPercent ? 'PERCENT' : 'NONE',
    bankFile: s.bankFileId ? { id: s.bankFileId, code: s.bankFileCode, label: `BF-${pad5(s.bankFileCode)}`, at: s.bankFileAt } : null,
    approvedAt: s.approvedAt, calculatedAt: s.calculatedAt,
    canEdit: editable, canDelete: s.status === 'DRAFT', canSuspend: ['DRAFT', 'REVIEW', 'FINAL_REVIEW'].includes(s.status), canResume: s.status === 'SUSPENDED',
    canSendReview: s.status === 'DRAFT', canFinalReview: s.status === 'REVIEW' && approver, canApprove: s.status === 'FINAL_REVIEW' && approver,
    canSendBack: approver && (['REVIEW', 'FINAL_REVIEW'].includes(s.status) || (s.status === 'APPROVED' && paid <= 0n)),
    createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

async function listSlips(req, runId, f) {
  const { companyId } = req.user;
  const r = await loadRun(companyId, runId);
  const where = ['s."runId" = :runId', 's."companyId" = :companyId'];
  const repl = { runId, companyId };
  if (f.status) { where.push('s.status = :status'); repl.status = f.status; }
  if (f.departmentId) { where.push('e."departmentId" = :departmentId'); repl.departmentId = f.departmentId; }
  if (f.department) { where.push('s."departmentName" ILIKE :dept'); repl.dept = `%${f.department}%`; }
  if (f.paid === 'unpaid') where.push(`s.status = 'APPROVED' AND s."paidAmount" < s."netAmount"`);
  if (f.search) {
    repl.like = `%${f.search}%`;
    const numeric = /^\d+$/.test(f.search) && f.search.length <= 8 ? ' OR s."empCode" = :n OR s.code = :n' : '';
    if (numeric) repl.n = Number(f.search);
    where.push(`(s."empName" ILIKE :like${numeric})`);
  }
  const limit = f.limit || 200;
  const page = f.page || 1;
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM ${SLIP_FROM} WHERE ${w}`, repl);
  const rows = await q(`SELECT ${SLIP_SELECT} FROM ${SLIP_FROM} WHERE ${w} ORDER BY s."empCode" LIMIT :limit OFFSET :offset`, { ...repl, limit, offset: (page - 1) * limit });
  const approver = await isApprover(req);
  const stats = await runStats(runId);
  return { run: runJson(r, stats), data: rows.map((s) => slipJson(s, approver)), page, limit, total: n };
}

async function loadSlip(companyId, id, transaction, forUpdate = false) {
  const [s] = await q(`SELECT ${SLIP_SELECT} FROM ${SLIP_FROM} WHERE s.id = :id AND s."companyId" = :companyId${forUpdate ? ' FOR UPDATE OF s' : ''}`, { id, companyId }, transaction);
  if (!s) throw AppError.notFound('Payslip');
  return s;
}

/** The payslip as the screen shows it: header, attendance of the month, summary, additions and deductions, the computation, the checks, leave, loans and payments. */
async function getSlip(req, id, transaction) {
  const { companyId } = req.user;
  const s = await loadSlip(companyId, id, transaction);
  const r = await loadRun(companyId, s.runId, transaction);
  const out = slipJson(s, await isApprover(req));
  const { first, last } = monthInfo(s.month);
  const days = await q(`SELECT to_char("dayDate", 'YYYY-MM-DD') AS date, code, "originalCode", to_char("firstIn" AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "in", to_char("lastOut" AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS "out",
      "workedMinutes", "overtimeMinutes", "lateMinutes", "restDay", edited FROM payroll_slip_days WHERE "slipId" = :id ORDER BY "dayDate"`, { id }, transaction);
  const byDate = new Map(days.map((d) => [d.date, d]));
  out.attendance = datesBetween(first, last).map((date) => {
    const d = byDate.get(date);
    return {
      date, day: cap(dayName(date)), dayName: dayName(date), code: d ? d.code : null, originalCode: d ? d.originalCode : null, edited: d ? d.edited : false, in: d ? d.in : null, out: d ? d.out : null,
      hours: d ? Math.round((d.workedMinutes / 60) * 100) / 100 : 0, overtimeMinutes: d ? d.overtimeMinutes : 0, noData: Boolean(d && d.code === '-'), inEmployment: Boolean(d),
    };
  });
  out.attendanceHours = Math.round((days.reduce((t, d) => t + d.workedMinutes, 0) / 60) * 100) / 100;
  // the rest days of the month: the weekly off day and the holidays of the class
  const holidays = await q(`SELECT to_char(h."holidayDate", 'YYYY-MM-DD') AS date, h.name FROM payroll_holidays h WHERE h."companyId" = :companyId AND h."holidayDate" BETWEEN :first AND :last
    AND (h."appliesToAll" OR EXISTS (SELECT 1 FROM payroll_holiday_groups hg WHERE hg."holidayId" = h.id AND hg."groupId" = :groupId))`, { companyId, first, last, groupId: s.groupId }, transaction);
  const hol = new Map(holidays.map((h) => [h.date, h.name]));
  out.holidays = datesBetween(first, last).filter((d) => hol.has(d) || dayName(d) === r.weeklyOffDay).map((d) => ({ date: d, day: dayName(d), reason: hol.get(d) || 'Weekly off' }));
  out.policy = { ...runPolicyOf(r), summary: policyService.summary(runPolicyOf(r)) };
  const loans = await slipLoanRows(id, transaction);
  out.loans = loans.map((l) => {
    const plan = schedule(toCents(l.approved), l.months, l.deductFrom);
    const thisMonth = plan.find((p) => p.month === s.month);
    return { loanId: l.loanId, appId: pad5(l.loanCode), emi: thisMonth ? money(thisMonth.cents) : '0.00', due: money(toCents(l.due)), amount: money(toCents(l.amount)), balanceBefore: money(toCents(l.balanceBefore)), balanceAfter: money(toCents(l.balanceBefore) - toCents(l.amount)), months: l.months, deductFrom: l.deductFrom };
  });
  out.loanBalance = money(loans.reduce((t, l) => t + toCents(l.balanceBefore), 0n));
  out.advances = (await slipAdvanceRows(id, transaction)).map((a) => ({ advanceId: a.advanceId, appId: pad5(a.advanceCode), label: `ADV-${pad5(a.advanceCode)}`, advanceDate: a.advanceDate, advanceAmount: money(toCents(a.advanceAmount)), due: money(toCents(a.due)), amount: money(toCents(a.amount)) }));
  const approvedLeaves = await q(`SELECT l.id, l.code, to_char(l."fromDate", 'YYYY-MM-DD') AS "fromDate", to_char(l."toDate", 'YYYY-MM-DD') AS "toDate", l.days, l.status FROM payroll_leaves l
    WHERE l."employeeId" = :employeeId AND l.status = 'APPROVED' AND l."fromDate" <= :last AND l."toDate" >= :first ORDER BY l."fromDate"`, { employeeId: s.employeeId, first, last }, transaction);
  const al = out.days.AL;
  out.leave = { balance: Number(s.alBalance), markedAL: al, adjusted: Number(s.alPaid), unpaidAL: al - Number(s.alPaid), applications: approvedLeaves.map((l) => ({ id: l.id, appId: pad5(l.code), fromDate: l.fromDate, toDate: l.toDate, days: l.days })) };
  const payments = await q(`SELECT v.id, v."voucherNo", to_char(v."voucherDate", 'YYYY-MM-DD') AS date, a.id AS "accountId", a.code AS "accountCode", a.name AS "accountName", v."refNo", v.notes, l.amount::text AS amount, v.status
    FROM salary_payment_voucher_lines l JOIN salary_payment_vouchers v ON v.id = l."voucherId" JOIN accounts a ON a.id = v."payFromAccountId" WHERE l."slipId" = :id ORDER BY v."voucherNo"`, { id }, transaction);
  out.payments = payments.map((p) => ({ voucherId: p.id, voucherLabel: `SPV-${pad5(p.voucherNo)}`, date: p.date, paidFrom: { id: p.accountId, code: p.accountCode, name: p.accountName }, refNo: p.refNo, remarks: p.notes, amount: money(toCents(p.amount)), status: p.status }));
  out.computation = computationSteps(out, s, r);
  out.checks = checksOf(out, s, days);
  return out;
}

/** The "Computation" tab: every step from the basic to the net. */
function computationSteps(o, s, r) {
  const c = s.calc || {};
  const d = o.days;
  const steps = [];
  const add = (key, label, value, note) => steps.push({ key, label, value, note: note || null });
  add('basic', 'Basic pay', o.basicSalary, `${s.salaryType.toLowerCase()} salary`);
  add('rate', s.salaryType === 'DAILY' ? 'Daily wage' : 'Salary per day', c.dailyRate, s.salaryType === 'DAILY' ? 'the wage of a day' : `basic / ${s.daysInMonth} days`);
  add('hourly', 'Salary per hour', c.hourlyRate, c.hourlyRate ? `salary per day / ${o.dutyHours} duty hours` : 'no duty hours');
  add('days', 'Paid days', String(o.payableDays), s.salaryType === 'FIXED' ? 'fixed salary: the whole month' : `P ${d.P} + L ${d.L} + R ${d.R} + AL paid ${o.alPaid} + HD ${d.HD} x 0.5 - late ${o.lateDeductionDays}`);
  add('late', 'Late penalty', String(o.lateDeductionDays), r.latesPerHalfDay > 0 ? `${d.L} lates, every ${r.latesPerHalfDay} = half a day` : 'lates are not penalised');
  add('earned', 'Basic earned', c.earned, 'rounded to the rupee');
  add('overtime', 'Overtime', c.overtimeAmount, `${o.overtimeHours} hrs / ${o.dutyHours} duty hrs = ${Math.round((c.overtimeDays || 0) * 100) / 100} days x factor ${c.overtimeFactor}`);
  add('gross', 'Gross salary', o.gross, 'basic earned + overtime');
  add('additions', 'Additions', o.additions.total, 'food + maintenance + mobile + others');
  add('deductions', 'Deductions', o.deductions.total, 'loan + advance + EOBI + income tax + others');
  add('net', 'Net payable', o.net, 'gross + additions - deductions');
  add('paid', 'Paid', o.paid, null);
  add('balance', 'Balance', o.balance, null);
  return steps;
}

/** The checklist of the payslip screen. */
function checksOf(o, s, days) {
  const noData = days.filter((d) => d.code === '-' && d.date <= today()).length;
  const checks = [];
  checks.push({ key: 'ATTENDANCE', label: 'Attendance checked', ok: noData === 0, message: noData ? `${noData} day${noData === 1 ? '' : 's'} have no attendance data (not paid)` : 'every day has attendance' });
  checks.push({ key: 'HOLIDAY', label: 'Holiday check', ok: true, message: `${o.holidays.length} rest day${o.holidays.length === 1 ? '' : 's'} this month, ${o.days.R} counted on the payslip` });
  checks.push({ key: 'LOAN', label: 'Loan check', ok: toCents(o.deductions.loan) <= toCents(o.loanBalance) || toCents(o.loanBalance) === 0n, message: `Loan balance: Rs ${o.loanBalance} / deducted: Rs ${o.deductions.loan}` });
  checks.push({ key: 'POLICY_LATE', label: 'Late policy applied', ok: true, message: o.policy.summary });
  checks.push({ key: 'POLICY_LEAVE', label: 'AL policy applied', ok: o.leave.unpaidAL === 0, message: `AL balance: ${o.leave.balance} / marked AL days: ${o.leave.markedAL} / adjusted: ${o.leave.adjusted}` });
  checks.push({ key: 'NET', label: 'Net salary', ok: toCents(o.net) >= 0n, message: toCents(o.net) >= 0n ? `Net payable Rs ${o.net}` : `Net payable is negative (Rs ${o.net}): the deductions are more than the salary` });
  return checks;
}

// ---- changing a payslip (Draft and Review only) ----

const assertEditable = (s) => {
  if (!EDITABLE.includes(s.status)) {
    throw AppError.rule(s.status === 'SUSPENDED' ? 'SLIP_SUSPENDED' : 'SLIP_LOCKED', s.status === 'SUSPENDED' ? 'This payslip is suspended: resume it first' : `A payslip in ${STATUS[s.status].text.toLowerCase()} cannot be changed: send it back to Draft first`);
  }
};

const AMOUNT_COLUMNS = { food: 'foodAmount', maintenance: 'maintenanceAmount', mobile: 'mobileAmount', othersAdd: 'othersAddAmount', eobi: 'eobiAmount', incomeTax: 'taxAmount', othersDeduct: 'othersDeductAmount' };

/** HR changes the inputs of the payslip: basic, duty hours, the additions, EOBI, income tax, other deductions, overtime hours, the loan instalments, cash payment, notes. */
async function updateSlip(req, id, c) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s0 = await loadSlip(companyId, id, transaction, true);
    assertEditable(s0);
    const before = slipJson(s0);
    const r = await loadRun(companyId, s0.runId, transaction);
    const s = { ...s0 };
    const calc = { ...(s.calc || {}), overrides: [...((s.calc || {}).overrides || [])] };
    const set = {};
    if (c.basicSalary !== undefined) { s.basicSalary = amt(c.basicSalary); set.basicSalary = s.basicSalary; }
    if (c.dutyHours !== undefined) { s.dutyHours = c.dutyHours; set.dutyHours = c.dutyHours; }
    for (const [k, col] of Object.entries(AMOUNT_COLUMNS)) {
      if (c[k] === undefined) continue;
      set[col] = amt(c[k]);
      s[col] = set[col];
      if (['eobi', 'incomeTax', 'food', 'maintenance'].includes(k)) { const key = k === 'incomeTax' ? 'tax' : k; if (!calc.overrides.includes(key)) calc.overrides.push(key); }
    }
    if (c.overtimeHours !== undefined) { s.overtimeMinutesManual = c.overtimeHours === null ? null : Math.round(c.overtimeHours * 60); set.overtimeMinutesManual = s.overtimeMinutesManual; }
    if (c.isCash !== undefined) { s.isCash = c.isCash; set.isCash = c.isCash; }
    if (c.notes !== undefined) { s.notes = c.notes || null; set.notes = s.notes; }
    if (c.loans) {
      const rows = await slipLoanRows(id, transaction);
      for (const l of c.loans) {
        const row = rows.find((x) => x.loanId === l.loanId);
        if (!row) throw AppError.notFound('Loan');
        const cents = toCents(amt(l.amount));
        if (cents > toCents(row.balanceBefore)) throw AppError.rule('LOAN_ADJUST_TOO_HIGH', `Loan #${pad5(row.loanCode)}: only ${money(toCents(row.balanceBefore))} is still owed`, { loanId: l.loanId, balance: money(toCents(row.balanceBefore)) });
        await run('UPDATE payroll_slip_loans SET amount = :amount WHERE id = :id', { id: row.id, amount: money(cents) }, transaction);
      }
    }
    if (c.advances) {
      const rows = await slipAdvanceRows(id, transaction);
      for (const a of c.advances) {
        const row = rows.find((x) => x.advanceId === a.advanceId);
        if (!row) throw AppError.notFound('Advance');
        const cents = toCents(amt(a.amount));
        if (cents > toCents(row.due)) throw AppError.rule('ADVANCE_ADJUST_TOO_HIGH', `Advance #${pad5(row.advanceCode)}: only ${money(toCents(row.due))} is still to be taken`, { advanceId: a.advanceId, due: money(toCents(row.due)) });
        await run('UPDATE payroll_slip_advances SET amount = :amount WHERE id = :id', { id: row.id, amount: money(cents) }, transaction);
      }
    }
    s.calc = calc;
    const keys = Object.keys(set);
    if (keys.length) await run(`UPDATE payroll_slips SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { id, ...set }, transaction);
    const loans = await slipLoanRows(id, transaction);
    const days = await slipDays(id, transaction);
    const advTotal = (await slipAdvanceRows(id, transaction)).reduce((t, a) => t + toCents(a.amount), 0n);
    const out = finish(stateOf(s, days, loans.reduce((t, l) => t + toCents(l.amount), 0n), advTotal), runPolicyOf(r));
    await save(id, out, { loanAmount: money(loans.reduce((t, l) => t + toCents(l.amount), 0n)), advanceAmount: money(advTotal) }, transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_UPDATED', entityType: 'PayrollSlip', entityId: id, before: { net: before.net, deductions: before.deductions, additions: before.additions }, after: { changed: Object.keys(c), net: money(out.r.net) } }, { transaction });
  });
  return getSlip(req, id);
}

/** HR changes the code of one day on the payslip (the attendance module is not touched). */
async function editDay(req, id, date, { code }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    assertEditable(s);
    const r = await loadRun(companyId, s.runId, transaction);
    const [d] = await q('SELECT "originalCode", code FROM payroll_slip_days WHERE "slipId" = :id AND "dayDate" = :date', { id, date }, transaction);
    if (!d) throw AppError.rule('NOT_A_DAY_OF_THE_SLIP', 'This date is outside the employee\'s days in this month');
    const base = d.originalCode;
    await run('UPDATE payroll_slip_days SET code = :code, edited = :edited WHERE "slipId" = :id AND "dayDate" = :date', { id, date, code, edited: code !== base }, transaction);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM payroll_slip_days WHERE "slipId" = :id AND edited', { id }, transaction);
    await run('UPDATE payroll_slips SET "daysEdited" = :edited WHERE id = :id', { id, edited: n > 0 }, transaction);
    const fresh = await loadSlip(companyId, id, transaction);
    await recalcSlip(req, fresh, r, runPolicyOf(r), transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_DAY_EDITED', entityType: 'PayrollSlip', entityId: id, before: { date, code: d.code }, after: { date, code } }, { transaction });
  });
  return getSlip(req, id);
}

/**
 * "Get attendance": copies the month's attendance of the attendance module onto the payslip again; every change HR made to the days is gone, the overtime goes back to what the
 * attendance says, and the loan instalments are asked again. The additions and the other deductions HR typed stay.
 */
async function getAttendance(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    assertEditable(s);
    const r = await loadRun(companyId, s.runId, transaction);
    const { first, last } = monthInfo(s.month);
    const until = today();
    const emp = { id: s.employeeId, joined: s.joined, leftOn: s.leftOn, groupId: s.groupId };
    if (first <= (last < until ? last : until)) await attendance.processRange(companyId, { from: first, to: last < until ? last : until, employeeIds: [s.employeeId] }, transaction);
    const att = await attendanceDays(companyId, [s.employeeId], first, last, transaction);
    const policy = runPolicyOf(r);
    const days = recode(daysFor(emp, att.get(s.employeeId), first, last, until), policy);
    await writeDays(id, days, transaction);
    const dues = (await loanDues(companyId, [s.employeeId], s.month, transaction)).get(s.employeeId);
    await run('DELETE FROM payroll_slip_loans WHERE "slipId" = :id', { id }, transaction);
    for (const d of dues) await run('INSERT INTO payroll_slip_loans ("slipId", "companyId", "loanId", due, amount, "balanceBefore") VALUES (:id, :companyId, :loanId, :due, :amount, :balance)',
      { id, companyId, loanId: d.loanId, due: money(d.due), amount: money(d.amount), balance: money(d.balance) }, transaction);
    const advs = (await advanceDues(companyId, [s.employeeId], s.month, transaction)).get(s.employeeId);
    await run('DELETE FROM payroll_slip_advances WHERE "slipId" = :id', { id }, transaction);
    for (const d of advs) await run('INSERT INTO payroll_slip_advances ("slipId", "companyId", "advanceId", due, amount) VALUES (:id, :companyId, :advanceId, :due, :amount)', { id, companyId, advanceId: d.advanceId, due: money(d.due), amount: money(d.amount) }, transaction);
    const bal = (await leaveBalances(companyId, [emp], s.groupId, s.month, first, policy, transaction)).get(s.employeeId) || 0;
    await run('UPDATE payroll_slips SET "overtimeMinutesManual" = NULL, "daysEdited" = false, "alBalance" = :bal WHERE id = :id', { id, bal }, transaction);
    const fresh = await refreshEobi(companyId, await loadSlip(companyId, id, transaction), transaction);
    await recalcSlip(req, fresh, r, policy, transaction, { days });
    await audit.log(req, { action: 'PAYROLL_SLIP_ATTENDANCE_PULLED', entityType: 'PayrollSlip', entityId: id, after: { days: days.length } }, { transaction });
  });
  return getSlip(req, id);
}

/** Calculates the payslip again from what it holds; `auto` gives EOBI and income tax back to the percents of the employee. */
async function calculateSlip(req, id, { auto } = {}) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    assertEditable(s);
    const r = await loadRun(companyId, s.runId, transaction);
    if (auto) {
      const calc = { ...(s.calc || {}), overrides: [] };
      await run('UPDATE payroll_slips SET calc = CAST(:calc AS jsonb) WHERE id = :id', { id, calc: JSON.stringify(calc) }, transaction);
      s.calc = calc;
    }
    await recalcSlip(req, await refreshEobi(companyId, s, transaction), r, runPolicyOf(r), transaction, { recodeDays: true });
  });
  return getSlip(req, id);
}

// ---- suspend and resume ----

async function suspend(req, id, { note }) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    if (s.status === 'APPROVED') throw AppError.rule('SLIP_APPROVED', 'An approved payslip cannot be suspended: send it back to Draft first');
    if (s.status === 'SUSPENDED') throw AppError.rule('ALREADY_SUSPENDED', 'This payslip is already suspended');
    await run('UPDATE payroll_slips SET status = \'SUSPENDED\', "suspendNote" = :note, "suspendedAt" = now(), "suspendedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, note, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_SUSPENDED', entityType: 'PayrollSlip', entityId: id, before: { status: s.status }, after: { note } }, { transaction });
  });
  return getSlip(req, id);
}

async function resume(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    if (s.status !== 'SUSPENDED') throw AppError.rule('NOT_SUSPENDED', 'This payslip is not suspended');
    const r = await loadRun(companyId, s.runId, transaction);
    await run('UPDATE payroll_slips SET status = \'DRAFT\', "suspendedAt" = NULL, "suspendedById" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await recalcSlip(req, await loadSlip(companyId, id, transaction), r, runPolicyOf(r), transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_RESUMED', entityType: 'PayrollSlip', entityId: id, after: { note: s.suspendNote } }, { transaction });
  });
  return getSlip(req, id);
}

async function removeSlip(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const s = await loadSlip(companyId, id, transaction, true);
    if (s.status !== 'DRAFT') throw AppError.rule('SLIP_NOT_DRAFT', 'Only a payslip in Draft can be deleted');
    await run('DELETE FROM payroll_slips WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_DELETED', entityType: 'PayrollSlip', entityId: id, before: { empCode: s.empCode, name: s.empName, month: s.month } }, { transaction });
  });
}

// ---- moving a payslip along; the accounting ----

async function assertApprover(req) {
  if (!(await isApprover(req))) throw AppError.forbidden('Only a reviewer (a client admin or a person chosen as approver) can do this');
}

/** The entry of an approved payslip: Debit Salaries & Wages (gross + additions); Credit Salaries Payable (net), Employee Loans (loan), EOBI Payable, Income Tax Payable and Other Employee Deductions. */
async function postSlip(req, s, transaction) {
  const earnings = toCents(s.grossAmount) + toCents(s.additionsAmount);
  const parts = [['SALARIES_PAYABLE', toCents(s.netAmount)], ['EMPLOYEE_LOANS', toCents(s.loanAmount)], ['EMPLOYEE_ADVANCES', toCents(s.advanceAmount)], ['EOBI_PAYABLE', toCents(s.eobiAmount)], ['SALARY_TAX_PAYABLE', toCents(s.taxAmount)], ['EMPLOYEE_DEDUCTIONS', toCents(s.othersDeductAmount)]].filter(([, c]) => c > 0n);
  if (earnings <= 0n || !parts.length) return null;
  const narration = `Payroll ${monthLabel(s.month)} - ${s.empName} (${pad5(s.empCode)}), payslip ${s.code}`;
  const lines = [{ accountId: await accountService.ensureDefault(req, 'SALARY_EXPENSE', transaction), debit: Number(money(earnings)), narration }];
  for (const [role, cents] of parts) lines.push({ accountId: await accountService.ensureDefault(req, role, transaction), credit: Number(money(cents)), narration });
  return journal.post(req, { entryDate: monthInfo(s.month).last, sourceType: SOURCE, sourceId: s.id, narration, lines }, transaction);
}

async function unpostSlip(req, s, transaction) {
  const [entry] = await q(`SELECT id FROM journal_entries WHERE "companyId" = :companyId AND "sourceType" = :source AND "sourceId" = :id AND status = 'POSTED' AND "reversalOfId" IS NULL`, { companyId: req.user.companyId, source: SOURCE, id: s.id }, transaction);
  if (entry) await journal.reverse(req, entry.id, { reason: `payslip ${s.code} sent back to draft` }, transaction);
}

/** One step of the flow for one payslip: 'review', 'final-review', 'approve' or 'send-back'. */
async function moveOne(req, id, action, transaction) {
  const { companyId } = req.user;
  const s = await loadSlip(companyId, id, transaction, true);
  const st = s.status;
  if (action === 'review') {
    if (st !== 'DRAFT') throw AppError.rule('NOT_DRAFT', 'Only a payslip in Draft can be moved to Review');
    if (toCents(s.netAmount) < 0n) throw AppError.rule('NET_NEGATIVE', `The net salary is negative (${money(toCents(s.netAmount))}): correct the deductions first`);
    await run('UPDATE payroll_slips SET status = \'REVIEW\', "updatedAt" = now() WHERE id = :id', { id }, transaction);
  } else if (action === 'final-review') {
    await assertApprover(req);
    if (st !== 'REVIEW') throw AppError.rule('NOT_IN_REVIEW', 'Only a payslip in Review can be moved to Final review');
    await run('UPDATE payroll_slips SET status = \'FINAL_REVIEW\', "updatedAt" = now() WHERE id = :id', { id }, transaction);
  } else if (action === 'approve') {
    await assertApprover(req);
    if (st !== 'FINAL_REVIEW') throw AppError.rule('NOT_IN_FINAL_REVIEW', 'Only a payslip in Final review can be approved');
    if (toCents(s.netAmount) < 0n) throw AppError.rule('NET_NEGATIVE', `The net salary is negative (${money(toCents(s.netAmount))})`);
    const entry = await postSlip(req, s, transaction);
    const loans = await slipLoanRows(id, transaction);
    for (const l of loans) {
      if (toCents(l.amount) <= 0n) continue;
      await run('INSERT INTO payroll_loan_deductions ("companyId", "loanId", month, amount, source, "payrollId", "createdById") VALUES (:companyId, :loanId, :month, :amount, \'PAYROLL\', :slipId, :userId)',
        { companyId, loanId: l.loanId, month: `${s.month}-01`, amount: l.amount, slipId: id, userId: req.user.id }, transaction);
    }
    for (const a of await slipAdvanceRows(id, transaction)) {
      if (toCents(a.amount) <= 0n) continue;
      await run('INSERT INTO payroll_advance_deductions ("companyId", "advanceId", month, amount, "payrollId", "createdById") VALUES (:companyId, :advanceId, :month, :amount, :slipId, :userId)',
        { companyId, advanceId: a.advanceId, month: `${s.month}-01`, amount: a.amount, slipId: id, userId: req.user.id }, transaction);
    }
    await run('UPDATE payroll_slips SET status = \'APPROVED\', "approvedAt" = now(), "approvedById" = :userId, "updatedAt" = now() WHERE id = :id', { id, userId: req.user.id }, transaction);
    await audit.log(req, { action: 'PAYROLL_SLIP_APPROVED', entityType: 'PayrollSlip', entityId: id, after: { empCode: s.empCode, month: s.month, net: money(toCents(s.netAmount)), journalEntryNo: entry ? entry.entryNo : null } }, { transaction });
    return;
  } else if (action === 'send-back') {
    await assertApprover(req);
    if (!['REVIEW', 'FINAL_REVIEW', 'APPROVED'].includes(st)) throw AppError.rule('CANNOT_SEND_BACK', 'Only a payslip in Review, Final review or Approved can be sent back to Draft');
    if (st === 'APPROVED') {
      if (toCents(s.paidAmount) > 0n) throw AppError.rule('SLIP_HAS_PAYMENTS', 'Something is already paid on this payslip: move the salary payment voucher to draft first');
      const [tv] = await q('SELECT 1 FROM salary_tax_voucher_lines WHERE "slipId" = :id LIMIT 1', { id }, transaction);
      if (tv) throw AppError.rule('SLIP_TAX_ON_VOUCHER', 'The tax of this payslip is on a salary tax voucher: delete that voucher (or take the payslip off it) first');
      const [pv] = await q('SELECT 1 FROM salary_payment_voucher_lines WHERE "slipId" = :id LIMIT 1', { id }, transaction);
      if (pv) throw AppError.rule('SLIP_IN_A_VOUCHER', 'This payslip is on a salary payment voucher: take it off the voucher first');
      await unpostSlip(req, s, transaction);
      await run('DELETE FROM payroll_loan_deductions WHERE "payrollId" = :id', { id }, transaction);
      await run('DELETE FROM payroll_advance_deductions WHERE "payrollId" = :id', { id }, transaction);
      await run('UPDATE payroll_slips SET "approvedAt" = NULL, "approvedById" = NULL, "bankFileId" = NULL WHERE id = :id', { id }, transaction);
    }
    await run('UPDATE payroll_slips SET status = \'DRAFT\', "updatedAt" = now() WHERE id = :id', { id }, transaction);
  } else throw AppError.rule('UNKNOWN_ACTION', 'Unknown action');
  await audit.log(req, { action: 'PAYROLL_SLIP_MOVED', entityType: 'PayrollSlip', entityId: id, before: { status: st }, after: { action } }, { transaction });
}

async function move(req, id, action) {
  await sequelize.transaction(async (transaction) => moveOne(req, id, action, transaction));
  return getSlip(req, id);
}

/** The same step for many payslips of a payroll (the selected ones, or every payslip that can take it). Each payslip is its own piece of work: one that cannot move is reported, the others move. */
async function moveMany(req, runId, { action, slipIds }) {
  const { companyId } = req.user;
  await loadRun(companyId, runId);
  if (action !== 'review') await assertApprover(req); // refused at once, not reported payslip by payslip
  const from = { review: 'DRAFT', 'final-review': 'REVIEW', approve: 'FINAL_REVIEW', 'send-back': null }[action];
  const where = ['s."runId" = :runId', 's."companyId" = :companyId'];
  const repl = { runId, companyId };
  if (from) { where.push('s.status = :from'); repl.from = from; } else where.push(`s.status IN ('REVIEW', 'FINAL_REVIEW', 'APPROVED')`);
  if (slipIds && slipIds.length) { where.push('s.id IN (:slipIds)'); repl.slipIds = slipIds; }
  const ids = (await q(`SELECT s.id, s."empCode", s."empName" FROM payroll_slips s WHERE ${where.join(' AND ')} ORDER BY s."empCode"`, repl)).slice(0, 1000);
  const moved = [];
  const failed = [];
  for (const s of ids) {
    try {
      await sequelize.transaction(async (transaction) => moveOne(req, s.id, action, transaction));
      moved.push(s.id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      failed.push({ slipId: s.id, empCode: s.empCode, name: s.empName, code: e.code, message: e.message });
    }
  }
  return { action, moved: moved.length, failed, run: await getRun(req, runId) };
}

/** The attendance tab of a payroll: every payslip with its day codes, for the month grid. */
async function runAttendance(req, runId) {
  const { companyId } = req.user;
  const r = await loadRun(companyId, runId);
  const { first, last } = monthInfo(r.month);
  const slips = await q('SELECT s.id, s."empCode", s."empName", s."departmentName", s.status, s."cntP", s."cntL", s."cntHD", s."cntA", s."cntR", s."cntAL", s."daysEdited" FROM payroll_slips s WHERE s."runId" = :runId ORDER BY s."empCode"', { runId });
  const days = await q(`SELECT d."slipId", to_char(d."dayDate", 'YYYY-MM-DD') AS date, d.code FROM payroll_slip_days d JOIN payroll_slips s ON s.id = d."slipId" WHERE s."runId" = :runId`, { runId });
  const by = new Map();
  for (const d of days) { if (!by.has(d.slipId)) by.set(d.slipId, {}); by.get(d.slipId)[d.date] = d.code; }
  return {
    run: runJson(r), dates: datesBetween(first, last),
    data: slips.map((s) => ({ slipId: s.id, employee: { code: s.empCode, label: pad5(s.empCode), name: s.empName, department: s.departmentName }, status: s.status, days: by.get(s.id) || {},
      totals: { P: s.cntP, L: s.cntL, HD: s.cntHD, A: s.cntA, R: s.cntR, AL: s.cntAL }, edited: s.daysEdited })),
  };
}

module.exports = {
  listRuns, getRun, createRun, addMissing, removeRun, setPolicy, listSlips, getSlip, updateSlip, editDay, getAttendance, calculateSlip, suspend, resume, removeSlip, move, moveMany, runAttendance,
  runsOfMonth, loadRun, runJson, runStats, STATUS, SOURCE, slipJson, SLIP_SELECT, SLIP_FROM, loadSlip, monthLabel, monthInfo, DAY_CODES,
};
