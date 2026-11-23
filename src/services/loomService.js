// Weaving > Masters > Loom: a loom no (unique per company, any letter case = the same) and the Department it belongs to (Masters > Department: e.g. Sulzer, Airjet).
// A loom that has beam entries cannot be deleted (switch it off); a loom with a running entry cannot be switched off.
const crypto = require('crypto');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const clean = (s) => String(s).trim().replace(/\s+/g, ' ');

const SQL = `SELECT l.id, l.code, l."loomNo", l."loomType", l."isActive", l."departmentId", l."createdAt", d.code AS "deptCode", d.name AS "deptName",
    (SELECT COUNT(*)::int FROM loom_entry_beams eb JOIN loom_entries e ON e.id = eb."entryId" WHERE e."loomId" = l.id AND e.status = 'ACTIVE') AS "beamsOnLoom",
    (SELECT COALESCE(array_agg(e."kId" ORDER BY e."kId"), '{}') FROM loom_entries e WHERE e."loomId" = l.id AND e.status = 'ACTIVE') AS "activeKIds"
  FROM looms l JOIN weaving_departments d ON d.id = l."departmentId"`;

const json = (r) => ({
  id: r.id, code: r.code, loomNo: r.loomNo, loomType: r.loomType || null, isActive: r.isActive, departmentId: r.departmentId, department: { id: r.departmentId, code: r.deptCode, name: r.deptName },
  // is a beam entry running on it: the loom is "running", else "idle"
  beamsOnLoom: r.beamsOnLoom, running: r.beamsOnLoom > 0, activeKIds: r.activeKIds, canTakeBeams: r.isActive && r.beamsOnLoom < 2, createdAt: r.createdAt,
});

async function load(companyId, id, transaction) {
  const [r] = await q(`${SQL} WHERE l.id = :id AND l."companyId" = :companyId AND l."deletedAt" IS NULL`, { id, companyId }, transaction);
  if (!r) throw AppError.notFound('Loom');
  return r;
}

async function checkDepartment(companyId, departmentId, keep, transaction) {
  const [d] = await q('SELECT "isActive" FROM weaving_departments WHERE id = :departmentId AND "companyId" = :companyId AND "deletedAt" IS NULL', { departmentId, companyId }, transaction);
  if (!d) throw AppError.rule('UNKNOWN_DEPARTMENT', 'This department does not exist', { field: 'departmentId' });
  if (!d.isActive && departmentId !== keep) throw AppError.rule('DEPARTMENT_INACTIVE', 'This department is switched off', { field: 'departmentId' });
}
async function checkNo(companyId, loomNo, exceptId, transaction) {
  const [d] = await q('SELECT id FROM looms WHERE "companyId" = :companyId AND lower("loomNo") = lower(:loomNo) AND "deletedAt" IS NULL AND (:ex::uuid IS NULL OR id <> :ex::uuid)', { companyId, loomNo, ex: exceptId || null }, transaction);
  if (d) throw AppError.rule('DUPLICATE_ENTRY', `Loom ${loomNo} already exists`, { field: 'loomNo' });
}

async function list(req, { page, limit, search, departmentId, isActive, running }) {
  const r = { companyId: req.user.companyId };
  const f = ['l."companyId" = :companyId', 'l."deletedAt" IS NULL'];
  if (departmentId) { f.push('l."departmentId" = :departmentId'); r.departmentId = departmentId; }
  if (isActive !== undefined) { f.push('l."isActive" = :isActive'); r.isActive = isActive; }
  if (search) { r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`; f.push('(l."loomNo" ILIKE :like OR d.name ILIKE :like)'); }
  const rows = await q(`${SQL} WHERE ${f.join(' AND ')} ORDER BY d.name, l."loomNo"`, r);
  let data = rows.map(json);
  if (running !== undefined) data = data.filter((l) => l.running === running);
  const total = data.length;
  return { data: data.slice((page - 1) * limit, page * limit), page, limit, total };
}

const get = async (req, id) => json(await load(req.user.companyId, id));

async function create(req, data) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `loom:${companyId}` }, transaction);
    const loomNo = clean(data.loomNo);
    await checkNo(companyId, loomNo, null, transaction);
    await checkDepartment(companyId, data.departmentId, null, transaction);
    const [{ next }] = await q('SELECT COALESCE(MAX(code), 0) + 1 AS next FROM looms WHERE "companyId" = :companyId', { companyId }, transaction);
    const id = crypto.randomUUID();
    await exec('INSERT INTO looms (id, "companyId", code, "loomNo", "loomType", "departmentId", "isActive", "createdById") VALUES (:id, :companyId, :code, :loomNo, :loomType, :departmentId, :isActive, :userId)',
      { id, companyId, code: Number(next), loomNo, loomType: data.loomType ? clean(data.loomType) : null, departmentId: data.departmentId, isActive: data.isActive !== false, userId: req.user.id }, transaction);
    const out = json(await load(companyId, id, transaction));
    await audit.log(req, { action: 'LOOM_CREATED', entityType: 'Loom', entityId: id, after: { loomNo: out.loomNo, department: out.department.name } }, { transaction });
    return out;
  });
}

async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    await exec('SELECT pg_advisory_xact_lock(hashtext(:k))', { k: `loom:${companyId}` }, transaction);
    const row = await load(companyId, id, transaction);
    const before = json(row);
    const set = {};
    if (changes.loomNo !== undefined) { const loomNo = clean(changes.loomNo); await checkNo(companyId, loomNo, id, transaction); set.loomNo = loomNo; }
    if (changes.loomType !== undefined) set.loomType = changes.loomType ? clean(changes.loomType) : null;
    if (changes.departmentId && changes.departmentId !== row.departmentId) { await checkDepartment(companyId, changes.departmentId, row.departmentId, transaction); set.departmentId = changes.departmentId; }
    if (changes.isActive !== undefined) {
      if (changes.isActive === false && row.beamsOnLoom > 0) throw AppError.rule('LOOM_RUNNING', 'Beams are running on this loom: cut it off before switching it off', { beamsOnLoom: row.beamsOnLoom });
      set.isActive = changes.isActive;
    }
    const keys = Object.keys(set);
    if (keys.length) await exec(`UPDATE looms SET ${keys.map((k) => `"${k}" = :${k}`).join(', ')}, "updatedAt" = now() WHERE id = :id`, { ...set, id }, transaction);
    const out = json(await load(companyId, id, transaction));
    await audit.log(req, { action: 'LOOM_UPDATED', entityType: 'Loom', entityId: id, before, after: out }, { transaction });
    return out;
  });
}

async function remove(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const row = await load(companyId, id, transaction);
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM loom_entries WHERE "loomId" = :id', { id }, transaction);
    const [{ p }] = await q('SELECT (SELECT COUNT(*) FROM production_units WHERE "loomId" = :id) + (SELECT COUNT(*) FROM production_weaver_looms WHERE "loomId" = :id) AS p', { id }, transaction);
    if (Number(p)) throw AppError.rule('IN_USE', 'This loom is in the production register. Switch it off instead of deleting it', { entries: n });
    if (n) throw AppError.rule('IN_USE', `This loom has ${n} beam entr${n === 1 ? 'y' : 'ies'}. Switch it off instead of deleting it`, { entries: n });
    await exec('UPDATE looms SET "deletedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'LOOM_DELETED', entityType: 'Loom', entityId: id, before: json(row) }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove };
