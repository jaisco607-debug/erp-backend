// Deleted items (owner 2026-11-25, N-A1). A grey lot that is deleted leaves the Grey Inward list and waits here:
//   - REVERT          the lot comes back to Grey Inward with its number, its thaans and everything it had
//   - PERMANENT DELETE the lot, its thaans and its returns are removed from the database tables; a copy of the record is kept in the archive table
//                      (deleted_items_archive) and the lot number is free again for a new entry
// While a lot waits here its number stays taken: a new entry with the same lot number is refused (LOT_NO_TAKEN, see greyLotService).
// Only the client admin works with this page. Lots made by a fabric issue (source STORE) are not here: they follow their fabric issue.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: 'SELECT' });
const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });
const KIND = 'GREY_LOT';
const iso = (v) => (v ? new Date(v).toISOString() : null);

// a lot that waits in Deleted items: deleted by a person (not cancelled with its fabric issue)
const WAITING = 'gl."deletedAt" IS NOT NULL AND gl."deleteKind" = \'DELETED\' AND gl.source <> \'STORE\'';

const lotJson = (r) => ({
  id: r.id, kind: 'lot', lotNo: r.lotNo, typeNo: r.typeNo, inwardDate: r.inwardDate, dcNo: r.dcNo || '', partyRef: r.partyRef || '',
  customer: { id: r.customerId, name: r.party, code: r.partyCode }, quality: { id: r.qualityId, name: r.quality || '' }, unit: r.unit, thaans: r.thaans, meters: Number(r.meters),
  reason: r.reason || '', deletedAt: iso(r.deletedAt), deletedBy: r.deletedByName || '', canRevert: true, canPermanentDelete: true,
});

const LOT_SQL = `SELECT gl.id, gl."lotNo", gl."typeNo", gl."inwardDate"::text AS "inwardDate", gl."dcNo", gl."partyRef", gl."customerId", cu.name AS party, cu.code AS "partyCode", gl."qualityId", qu.name AS quality, gl.unit,
    COALESCE(NULLIF((SELECT count(*) FROM grey_lot_thaans t WHERE t."lotId" = gl.id), 0), gl.pieces)::int AS thaans, gl."inwardMeters"::float AS meters,
    gl."deleteReason" AS reason, gl."deletedAt", u.name AS "deletedByName"
  FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId" LEFT JOIN users u ON u.id = gl."deletedById"`;

/** GET /deleted-items?kind=lot&view=deleted|permanent&search=&page=&limit= */
async function list(req, { view = 'deleted', search, page = 1, limit = 50 }) {
  const { companyId } = req.user;
  const counts = {
    deleted: (await q(`SELECT count(*)::int AS n FROM grey_lots gl WHERE gl."companyId" = :companyId AND ${WAITING}`, { companyId }))[0].n,
    permanent: (await q('SELECT count(*)::int AS n FROM deleted_items_archive WHERE "companyId" = :companyId AND kind = :kind', { companyId, kind: KIND }))[0].n,
  };
  const like = search ? `%${String(search).trim()}%` : null;
  if (view === 'permanent') {
    const where = ['a."companyId" = :companyId', 'a.kind = :kind'];
    const rep = { companyId, kind: KIND };
    if (like) { where.push('(a."itemNo"::text = :search OR a.title ILIKE :like OR a."deleteReason" ILIKE :like)'); rep.search = String(search).trim(); rep.like = like; }
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM deleted_items_archive a WHERE ${where.join(' AND ')}`, rep);
    const rows = await q(`SELECT a.id, a."itemNo", a.title, a.snapshot, a."deletedAt", a."deleteReason", a."purgedAt", d.name AS "deletedByName", p.name AS "purgedByName"
      FROM deleted_items_archive a LEFT JOIN users d ON d.id = a."deletedById" LEFT JOIN users p ON p.id = a."purgedById" WHERE ${where.join(' AND ')} ORDER BY a."purgedAt" DESC LIMIT :limit OFFSET :offset`,
    { ...rep, limit, offset: (page - 1) * limit });
    const data = rows.map((r) => {
      const lot = (r.snapshot && r.snapshot.lot) || {};
      return {
        id: r.id, kind: 'lot', lotNo: r.itemNo, title: r.title, typeNo: lot.typeNo || null, inwardDate: lot.inwardDate || null, meters: Number(lot.inwardMeters || 0),
        thaans: ((r.snapshot && r.snapshot.thaans) || []).length, reason: r.deleteReason || '', deletedAt: iso(r.deletedAt), deletedBy: r.deletedByName || '',
        permanentlyDeletedAt: iso(r.purgedAt), permanentlyDeletedBy: r.purgedByName || '', canRevert: false, canPermanentDelete: false,
      };
    });
    return { view, counts, data, page, limit, total: n };
  }
  const where = ['gl."companyId" = :companyId', WAITING];
  const rep = { companyId };
  if (like) { where.push('(gl."lotNo"::text = :search OR gl."typeNo" ILIKE :like OR gl."dcNo" ILIKE :like OR gl."partyRef" ILIKE :like OR cu.name ILIKE :like OR qu.name ILIKE :like OR gl."deleteReason" ILIKE :like)'); rep.search = String(search).trim(); rep.like = like; }
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId" WHERE ${where.join(' AND ')}`, rep);
  const rows = await q(`${LOT_SQL} WHERE ${where.join(' AND ')} ORDER BY gl."deletedAt" DESC, gl."lotNo" DESC LIMIT :limit OFFSET :offset`, { ...rep, limit, offset: (page - 1) * limit });
  return { view: 'deleted', counts, data: rows.map(lotJson), page, limit, total: n };
}

/** The lot, locked, that is waiting in Deleted items (not found / not deleted / not a person's delete are refused). */
async function waitingLot(req, id, transaction) {
  const [lot] = await q('SELECT id, "lotNo", "typeNo", source, "deletedAt", "deleteKind", "deleteReason" FROM grey_lots WHERE id = :id AND "companyId" = :companyId FOR UPDATE', { id, companyId: req.user.companyId }, transaction);
  if (!lot) throw AppError.notFound('Deleted lot');
  if (!lot.deletedAt) throw AppError.rule('NOT_DELETED', `Lot ${lot.lotNo} is not deleted`);
  if (lot.deleteKind !== 'DELETED' || lot.source === 'STORE') throw AppError.rule('NOT_IN_DELETED_ITEMS', `Lot ${lot.lotNo} was cancelled with its fabric issue: it follows the fabric issue`);
  return lot;
}

/** POST /deleted-items/lot/:id/restore: the lot comes back to Grey Inward as it was. */
async function restoreLot(req, id) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const lot = await waitingLot(req, id, transaction);
    // the number was kept for this lot while it waited; this only guards a number that someone took in another way
    const [clash] = await q('SELECT "lotNo" FROM grey_lots WHERE "companyId" = :companyId AND id <> :id AND "deletedAt" IS NULL AND ("lotNo" = :lotNo OR "typeNo" = :typeNo)', { companyId, id, lotNo: lot.lotNo, typeNo: lot.typeNo }, transaction);
    if (clash) throw AppError.rule('LOT_NO_TAKEN', `Lot ${lot.lotNo} (or its type number ${lot.typeNo}) is used by another lot now: the lot cannot come back`, { lotNo: lot.lotNo });
    await exec('UPDATE grey_lots SET "deletedAt" = NULL, "deletedById" = NULL, "deleteKind" = NULL, "deleteReason" = NULL, "updatedAt" = now() WHERE id = :id', { id }, transaction);
    await audit.log(req, { action: 'GREY_LOT_RESTORED', entityType: 'GreyLot', entityId: id, before: { lotNo: lot.lotNo, deleteReason: lot.deleteReason }, after: { lotNo: lot.lotNo, restored: true } }, { transaction });
    return { id, lotNo: lot.lotNo, restored: true };
  });
}

/** POST /deleted-items/lot/:id/permanent-delete { lotNo }: the lot leaves the database tables; one copy stays in the archive; the number is free again. */
async function purgeLot(req, id, { lotNo }) {
  const { companyId } = req.user;
  try {
    return await sequelize.transaction(async (transaction) => {
      const lot = await waitingLot(req, id, transaction);
      if (Number(lotNo) !== lot.lotNo) throw AppError.rule('CONFIRM_MISMATCH', `Type the lot number ${lot.lotNo} to delete it for good`, { field: 'lotNo' });
      const [row] = await q(`SELECT gl.*, cu.name AS "customerName", qu.name AS "qualityName" FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId" WHERE gl.id = :id`, { id }, transaction);
      const thaans = await q('SELECT * FROM grey_lot_thaans WHERE "lotId" = :id ORDER BY "thaanNo"', { id }, transaction);
      const returns = await q('SELECT * FROM grey_returns WHERE "lotId" = :id', { id }, transaction);
      const { customerName, qualityName, ...lotRow } = row;
      const title = `Lot ${lot.lotNo} - ${customerName} - ${qualityName || ''} - ${Number(row.inwardMeters)} m`.slice(0, 250);
      await exec(`INSERT INTO deleted_items_archive ("companyId", kind, "originalId", "itemNo", title, snapshot, "deletedById", "deletedAt", "deleteReason", "purgedById")
        VALUES (:companyId, :kind, :id, :lotNo, :title, CAST(:snapshot AS jsonb), :deletedById, :deletedAt, :reason, :userId)`,
      { companyId, kind: KIND, id, lotNo: lot.lotNo, title, snapshot: JSON.stringify({ lot: lotRow, thaans, returns }), deletedById: row.deletedById || null, deletedAt: row.deletedAt || null, reason: row.deleteReason || null, userId: req.user.id }, transaction);
      // the thaans point to the returns, so they go first
      await exec('DELETE FROM grey_lot_thaans WHERE "lotId" = :id', { id }, transaction);
      await exec('DELETE FROM grey_returns WHERE "lotId" = :id', { id }, transaction);
      await exec('DELETE FROM grey_lots WHERE id = :id', { id }, transaction);
      await audit.log(req, { action: 'GREY_LOT_PERMANENTLY_DELETED', entityType: 'GreyLot', entityId: id, before: { lotNo: lot.lotNo, customer: customerName, quality: qualityName, meters: Number(row.inwardMeters), thaans: thaans.length, deleteReason: row.deleteReason } }, { transaction });
      return { id, lotNo: lot.lotNo, permanentlyDeleted: true };
    });
  } catch (e) {
    // another record still points at the lot (a card, a packing list ...): it cannot leave the database
    if (e && ((e.original && e.original.code === '23503') || (e.parent && e.parent.code === '23503') || e.name === 'SequelizeForeignKeyConstraintError')) {
      throw AppError.rule('LOT_HAS_RECORDS', 'Other records still point to this lot, so it cannot be deleted for good. Revert it, or ask the backend.');
    }
    throw e;
  }
}

module.exports = { list, restoreLot, purgeLot };
