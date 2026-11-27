// What a department charges per meter (owner plan N-C1): the "department charge" of every department the cloth went through and the "packing cost" of Packing, in the SO card margin.
// A rate is valid from a date until the next one; the margin uses the rate of the day of each job. Settings only: nothing posts to the accounts.
const AppError = require('../utils/AppError');
const { sequelize } = require('../models');
const { companyServices } = require('./accessService');
const audit = require('./auditService');
const { today } = require('../utils/dates');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: 'SELECT', transaction });
const KINDS = ['PROCESS', 'FOLDING', 'PACKING'];

/** The departments of the company that can have a rate. */
const departmentsOf = async (companyId) => (await companyServices(companyId)).filter((s) => KINDS.includes(s.kind));

/** Every rate of the company: Map departmentId -> [{ id, ratePerMeter, effectiveFrom }] newest first. */
async function ratesOf(companyId) {
  const rows = await q('SELECT id, "departmentId", "ratePerMeter"::float AS "ratePerMeter", to_char("effectiveFrom", \'YYYY-MM-DD\') AS "effectiveFrom" FROM process_rates WHERE "companyId" = :companyId ORDER BY "effectiveFrom" DESC', { companyId });
  const out = new Map();
  for (const r of rows) { if (!out.has(r.departmentId)) out.set(r.departmentId, []); out.get(r.departmentId).push({ id: r.id, ratePerMeter: r.ratePerMeter, effectiveFrom: r.effectiveFrom }); }
  return out;
}
/** The rate of a department on a day (the latest one that started on or before it), or null. */
const rateOn = (list, day) => ((list || []).find((r) => r.effectiveFrom <= day) || {}).ratePerMeter ?? null;

async function list(req) {
  const { companyId } = req.user;
  const rates = await ratesOf(companyId);
  const t = today();
  return {
    departments: (await departmentsOf(companyId)).map((d) => ({ id: d.id, code: d.code, name: d.name, kind: d.kind, currentRate: rateOn(rates.get(d.id), t), rates: rates.get(d.id) || [] })),
    note: 'A rate is per meter and counts from its date. The SO card margin uses the rate of the day of each job.',
  };
}

/** Adds the rate of a department from a date; the same department and date again changes that rate. */
async function save(req, { departmentId, ratePerMeter, effectiveFrom }) {
  const { companyId } = req.user;
  if (!(await departmentsOf(companyId)).some((d) => d.id === departmentId)) throw AppError.notFound('Department');
  await sequelize.transaction(async (transaction) => {
    const [before] = await q('SELECT id, "ratePerMeter"::float AS r FROM process_rates WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "effectiveFrom" = :effectiveFrom FOR UPDATE', { companyId, departmentId, effectiveFrom }, transaction);
    await sequelize.query(`INSERT INTO process_rates ("companyId", "departmentId", "ratePerMeter", "effectiveFrom", "createdById") VALUES (:companyId, :departmentId, :ratePerMeter, :effectiveFrom, :userId)
      ON CONFLICT ("companyId", "departmentId", "effectiveFrom") DO UPDATE SET "ratePerMeter" = EXCLUDED."ratePerMeter", "updatedAt" = now()`, { replacements: { companyId, departmentId, ratePerMeter, effectiveFrom, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PROCESS_RATE_SET', entityType: 'ProcessRate', entityId: departmentId, before: before ? { ratePerMeter: before.r, effectiveFrom } : null, after: { ratePerMeter, effectiveFrom } }, { transaction });
  });
  return list(req);
}

async function remove(req, id) {
  const { companyId } = req.user;
  await sequelize.transaction(async (transaction) => {
    const [row] = await q('SELECT id, "departmentId", "ratePerMeter"::float AS r, to_char("effectiveFrom", \'YYYY-MM-DD\') AS d FROM process_rates WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId }, transaction);
    if (!row) throw AppError.notFound('Rate');
    await sequelize.query('DELETE FROM process_rates WHERE id = :id', { replacements: { id }, transaction });
    await audit.log(req, { action: 'PROCESS_RATE_DELETED', entityType: 'ProcessRate', entityId: row.departmentId, before: { ratePerMeter: row.r, effectiveFrom: row.d } }, { transaction });
  });
  return list(req);
}

module.exports = { list, save, remove, ratesOf, rateOn, departmentsOf };
