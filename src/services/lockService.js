// Edit locks (frontend request, 2026-10-21). Only the person who opened a record for editing may edit it.
//   acquire    take the lock (atomic: of two simultaneous requests exactly one wins)
//   heartbeat  the browser renews it every 30 s; a lock lives 90 s, so a closed browser frees the record by itself
//   release    give it back
//   assertFree called before every write: a live lock of somebody else (or of another tab of the same person) answers 423
// Locks never cross companies. The super admin's lock on a company's services uses the target company id as its company.
const { QueryTypes } = require('sequelize');
const { sequelize, Service } = require('../models');
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('./accessService');

const TTL_SECONDS = 90;
const TYPES = ['job', 'folding_row', 'grey_lot', 'packing_list', 'so_card', 'chemical_request', 'company_services', 'user'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });

const lockJSON = (l) => ({
  lockId: l.id, resourceType: l.resourceType, resourceId: l.resourceId, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt,
  holder: { id: l.userId, name: l.holderName },
});

/** The company a lock belongs to: the target company for the super admin's service locks, else the signed-in company. */
const scopeOf = (req, type, id) => (type === 'company_services' ? id : req.user.companyId);

/**
 * Finds the record (in the signed-in company) and says which services may edit it.
 * { found, anyService: [ids], adminOnly, superOnly }
 */
async function describe(req, type, id) {
  const companyId = req.user.companyId;
  const special = async (...codes) => (await Service.findAll({ where: { code: codes }, attributes: ['id'] })).map((s) => s.id);
  const packing = async () => (await companyServices(companyId)).filter((s) => s.kind === 'PACKING').map((s) => s.id);
  if (type === 'company_services') {
    if (!UUID.test(id)) return { found: false };
    const [c] = await q('SELECT id FROM companies WHERE id = :id AND "deletedAt" IS NULL', { id });
    return { found: Boolean(c), superOnly: true };
  }
  if (!companyId) return { found: false };
  if (type === 'user') {
    if (!UUID.test(id)) return { found: false };
    const [u] = await q('SELECT id FROM users WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id, companyId });
    return { found: Boolean(u), adminOnly: true };
  }
  if (type === 'job') {
    if (!UUID.test(id)) return { found: false };
    const [j] = await q('SELECT "departmentId", "fromDepartmentId" FROM jobs WHERE id = :id AND "companyId" = :companyId', { id, companyId });
    return { found: Boolean(j), anyService: j ? [j.departmentId, j.fromDepartmentId, ...(await special('SO_CARD', 'GREY_STORE'))].filter(Boolean) : [] };
  }
  if (type === 'folding_row') {
    const [jobId, soCardId] = id.split(':');
    if (!UUID.test(jobId || '') || !UUID.test(soCardId || '')) return { found: false };
    const [j] = await q(`SELECT j."departmentId" FROM jobs j JOIN job_items ji ON ji."jobId" = j.id
      WHERE j.id = :jobId AND j."companyId" = :companyId AND ji."soCardId" = :soCardId LIMIT 1`, { jobId, soCardId, companyId });
    return { found: Boolean(j), anyService: j ? [j.departmentId] : [] };
  }
  if (type === 'grey_lot') {
    if (!UUID.test(id)) return { found: false };
    const [l] = await q('SELECT id FROM grey_lots WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id, companyId });
    return { found: Boolean(l), anyService: await special('GREY_STORE') };
  }
  if (type === 'so_card') {
    if (!UUID.test(id)) return { found: false };
    const [c] = await q('SELECT id FROM so_cards WHERE id = :id AND "companyId" = :companyId AND "deletedAt" IS NULL', { id, companyId });
    return { found: Boolean(c), anyService: await special('SO_CARD', 'GREY_STORE') };
  }
  if (type === 'packing_list') {
    const isNew = id.startsWith('so:');
    const key = isNew ? id.slice(3) : id;
    if (!UUID.test(key)) return { found: false };
    const [r] = isNew
      ? await q('SELECT id FROM so_cards WHERE id = :key AND "companyId" = :companyId AND "deletedAt" IS NULL', { key, companyId })
      : await q('SELECT id FROM packing_lists WHERE id = :key AND "companyId" = :companyId', { key, companyId });
    return { found: Boolean(r), anyService: await packing() };
  }
  if (type === 'chemical_request') {
    if (!UUID.test(id)) return { found: false };
    const [r] = await q('SELECT "departmentId" FROM chemical_requests WHERE id = :id AND "companyId" = :companyId', { id, companyId });
    return { found: Boolean(r), anyService: r ? [r.departmentId, ...(await special('CHEMICAL_STORE'))] : [] };
  }
  return { found: false };
}

/** May this person edit the record? (client admin: everything of the company; employee: FULL on a service that edits it) */
async function mayEdit(req, d) {
  if (d.superOnly) return req.user.userType === 'SUPER_ADMIN';
  if (req.user.userType === 'SUPER_ADMIN') return false;
  if (req.user.userType === 'CLIENT_ADMIN') return true;
  if (d.adminOnly) return false;
  const grants = await userServices(req.user);
  return grants.some((g) => g.access === 'FULL' && d.anyService.includes(g.service.id));
}

async function liveLock(companyId, type, id, transaction) {
  const [l] = await q(`SELECT e.*, u.name AS "holderName" FROM edit_locks e JOIN users u ON u.id = e."userId"
    WHERE e."companyId" = :companyId AND e."resourceType" = :type AND e."resourceId" = :id AND e."expiresAt" > now()`, { companyId, type, id }, transaction);
  return l || null;
}

const lockedError = (l) => AppError.locked(`${l.holderName} is editing this`, {
  holder: { id: l.userId, name: l.holderName }, since: l.acquiredAt, expiresAt: l.expiresAt,
});

async function acquire(req, { resourceType, resourceId, tabId }) {
  const d = await describe(req, resourceType, resourceId);
  if (!d.found) throw AppError.notFound('Record');
  if (!(await mayEdit(req, d))) throw AppError.forbidden('You cannot edit this');
  const companyId = scopeOf(req, resourceType, resourceId);
  // one atomic statement: a free or expired row is taken, the holder's own row (same tab) is renewed, anything else wins nothing
  const rows = await sequelize.query(`
    INSERT INTO edit_locks (id, "companyId", "resourceType", "resourceId", "userId", "tabId", "acquiredAt", "expiresAt")
    VALUES (gen_random_uuid(), :companyId, :resourceType, :resourceId, :userId, :tabId, now(), now() + make_interval(secs => :ttl))
    ON CONFLICT ("companyId", "resourceType", "resourceId") DO UPDATE SET
      id = CASE WHEN edit_locks."expiresAt" <= now() THEN EXCLUDED.id ELSE edit_locks.id END,
      "acquiredAt" = CASE WHEN edit_locks."expiresAt" <= now() THEN now() ELSE edit_locks."acquiredAt" END,
      "userId" = EXCLUDED."userId", "tabId" = EXCLUDED."tabId", "expiresAt" = EXCLUDED."expiresAt"
    WHERE edit_locks."expiresAt" <= now() OR (edit_locks."userId" = EXCLUDED."userId" AND edit_locks."tabId" = EXCLUDED."tabId")
    RETURNING id`, { replacements: { companyId, resourceType, resourceId, userId: req.user.id, tabId, ttl: TTL_SECONDS }, type: QueryTypes.SELECT });
  const mine = await liveLock(companyId, resourceType, resourceId);
  if (!rows.length || !mine || mine.userId !== req.user.id) throw lockedError(mine || { holderName: 'Someone', userId: null, acquiredAt: null, expiresAt: null });
  return lockJSON(mine);
}

async function heartbeat(req, lockId) {
  const rows = UUID.test(lockId)
    ? await sequelize.query(`UPDATE edit_locks SET "expiresAt" = now() + make_interval(secs => :ttl)
        WHERE id = :lockId AND "userId" = :userId AND "expiresAt" > now() RETURNING "expiresAt"`,
    { replacements: { lockId, userId: req.user.id, ttl: TTL_SECONDS }, type: QueryTypes.SELECT })
    : [];
  if (!rows.length) throw new AppError(404, 'LOCK_LOST', 'This lock has ended');
  return { expiresAt: rows[0].expiresAt };
}

async function release(req, lockId) {
  if (!UUID.test(lockId)) return;
  const [l] = await q('SELECT "userId" FROM edit_locks WHERE id = :lockId', { lockId });
  if (!l) return;
  if (l.userId !== req.user.id) throw AppError.forbidden('This lock belongs to someone else');
  await sequelize.query('DELETE FROM edit_locks WHERE id = :lockId AND "userId" = :userId', { replacements: { lockId, userId: req.user.id } });
}

async function current(req, { resourceType, resourceId }) {
  const l = await liveLock(scopeOf(req, resourceType, resourceId), resourceType, resourceId);
  return l ? { lockId: l.id, holder: { id: l.userId, name: l.holderName }, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt } : null;
}

/**
 * Called before a write: every resource must be free, or locked by this person in this tab.
 * resources: [{ type, id }]. tabId comes from the X-Tab-Id header (without it, any tab of the holder passes).
 */
async function assertFree(req, resources, transaction) {
  const tabId = req.headers['x-tab-id'];
  for (const r of resources) {
    const l = await liveLock(scopeOf(req, r.type, r.id), r.type, r.id, transaction);
    if (l && (l.userId !== req.user.id || (tabId && l.tabId !== tabId))) throw lockedError(l);
  }
}

/** Gives back every lock of these people (logout, switched off, deleted). */
async function releaseAllForUsers(userIds, transaction) {
  const ids = [].concat(userIds).filter(Boolean);
  if (!ids.length) return;
  await sequelize.query('DELETE FROM edit_locks WHERE "userId" IN (:ids)', { replacements: { ids }, transaction });
}

/** Housekeeping: rows that ran out long ago. */
async function cleanup() {
  await sequelize.query(`DELETE FROM edit_locks WHERE "expiresAt" < now() - interval '1 hour'`);
}

module.exports = { TYPES, acquire, heartbeat, release, current, assertFree, releaseAllForUsers, cleanup };
