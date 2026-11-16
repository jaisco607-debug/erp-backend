// Store Management > Fabric Issue: Fabric Store cloth (bought from a vendor, see fabricInwardService) goes to a customer's SO card.
// - An issue takes whole thaans (or meters, for an entry without a thaan list) of ONE approved fabric inward for a CUSTOMER and makes an approved
//   lot of that customer (grey_lots.source = 'STORE'). The SO card is then made the normal way from that lot, so thaans, jobs, folding, packing
//   and the reports all work unchanged; the card shows that its cloth came from the store (clothSource) and which card it replaces.
// - Optional link: linkedSoCardId = the earlier SO card whose cloth was spoilt. Then the customer is that card's customer. Without a link the
//   customer is chosen. Linking is never required.
// - The Fabric Store stock falls by the issue; the ledger and the issue list say where every meter went (customer, SO card, linked card).
// - An issue can be cancelled while its cloth is on no SO card (cancel the card first); the thaans return to the stock.
const { QueryTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize, FabricInward, FabricInwardThaan, FabricIssue, Customer, SoCard, GreyLot, GreyLotThaan } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { round: r2 } = require('../utils/money');
const { soLabel } = require('../utils/soLabel');
const audit = require('./auditService');
const counters = require('./counterService');
const greyLots = require('./greyLotService');

const NO = 'fabric_issue_no';
const YARD = 0.9144;
const issueText = (n) => String(n).padStart(5, '0');
const inwardText = (n) => String(n).padStart(5, '0');
const toYards = (m) => r2(m / YARD);
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });

const BASE = `FROM fabric_issues fi
  JOIN fabric_inwards fin ON fin.id = fi."fabricInwardId"
  JOIN vendors v ON v.id = fin."vendorId"
  JOIN qualities ql ON ql.id = fin."qualityId"
  JOIN customers c ON c.id = fi."customerId"
  JOIN grey_lots gl ON gl.id = fi."greyLotId"
  LEFT JOIN so_cards lc ON lc.id = fi."linkedSoCardId"`;
const COLS = `fi.id, fi."issueNo", fi."issueDate", fi.meters::float AS meters, fi.pieces, fi.remarks, fi."createdAt", fi."cancelledAt", fi."endKind", fi."thaanNos", fin."inwardDate",
  fin.id AS "inwardId", fin."inwardNo", fin."dcNo", fin.unit, v.id AS "vendorId", v.name AS "vendorName", v.code AS "vendorCode", ql.id AS "qualityId", ql.name AS "qualityName",
  c.id AS "customerId", c.name AS "customerName", c.code AS "customerCode", gl.id AS "lotId", gl."lotNo", gl."typeNo", gl."outwardMeters"::float AS "usedMeters",
  lc.id AS "linkedId", lc."cardNo" AS "linkedNo", lc."isGreyReturn" AS "linkedFr", lc."cardDate" AS "linkedDate"`;

function row(r, cards = []) {
  const yd = (v) => (r.unit === 'YARD' ? toYards(v) : null);
  const cancelled = Boolean(r.cancelledAt);
  return {
    id: r.id,
    issueNo: r.issueNo,
    issueText: issueText(r.issueNo),
    issueDate: r.issueDate,
    status: cancelled ? 'RETURNED' : 'ISSUED',
    statusText: cancelled ? 'Returned to store' : 'Issued',
    fabricInward: { id: r.inwardId, inwardNo: r.inwardNo, inwardDate: r.inwardDate, inwardText: inwardText(r.inwardNo), dcNo: r.dcNo, vendor: { id: r.vendorId, code: r.vendorCode, name: r.vendorName }, quality: { id: r.qualityId, name: r.qualityName } },
    customer: { id: r.customerId, code: r.customerCode, name: r.customerName },
    // the earlier SO card whose spoilt cloth this replaces (empty when the issue is not linked)
    isLinked: Boolean(r.linkedId),
    linkedSoCard: r.linkedId ? { id: r.linkedId, cardNo: r.linkedNo, cardLabel: soLabel(r.linkedNo, r.linkedFr), cardDate: r.linkedDate } : null,
    lot: { id: r.lotId, lotNo: r.lotNo, typeNo: r.typeNo },
    meters: r.meters,
    yards: yd(r.meters),
    unit: r.unit,
    pieces: r.pieces,
    remarks: r.remarks,
    // the SO cards this cloth is on, and how much of it they took
    usedMeters: r.usedMeters,
    soCards: cards.map((c) => ({ id: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, c.isGreyReturn), meters: Number(c.meters) })),
    // delete / edit: a RETURNED issue (the cloth is back in the stock), or an ISSUED one whose cloth is on no SO card
    canCancel: cancelled || r.usedMeters === 0,
    canEdit: cancelled || r.usedMeters === 0,
    // the thaan numbers the issue holds (a RETURNED issue: the ones it held when it was returned)
    thaanNos: r.thaanNos || [],
    createdAt: r.createdAt,
    cancelledAt: r.cancelledAt,
  };
}

async function cardsOf(lotIds, transaction) {
  const map = new Map();
  if (!lotIds.length) return map;
  const rows = await q(`SELECT scl."greyLotId" AS lot, sc.id, sc."cardNo", sc."isGreyReturn", sum(scl.meters)::float AS meters FROM so_card_lots scl
    JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" IN (:ids) GROUP BY scl."greyLotId", sc.id, sc."cardNo", sc."isGreyReturn" ORDER BY sc."cardNo"`, { ids: lotIds }, transaction);
  for (const r of rows) { if (!map.has(r.lot)) map.set(r.lot, []); map.get(r.lot).push(r); }
  return map;
}

async function loadOne(req, id, transaction) {
  const [r] = await q(`SELECT ${COLS} ${BASE} WHERE fi.id = :id AND fi."companyId" = :cid`, { id, cid: req.user.companyId }, transaction);
  if (!r) throw AppError.notFound('Fabric issue');
  const cards = await cardsOf([r.lotId], transaction);
  const out = row(r, cards.get(r.lotId) || []);
  // what the edit form can tick: the free thaans of the entry plus the ones this issue holds (an entry without thaans: the meters it may take)
  const thaans = await FabricInwardThaan.findAll({ where: { inwardId: r.inwardId }, order: [['thaanNo', 'ASC']], transaction });
  const inward = await FabricInward.findByPk(r.inwardId, { paranoid: false, transaction });
  const mine = new Set(out.thaanNos);
  out.editThaans = out.canEdit ? thaans.filter((t) => (t.status === 'IN_STOCK' && t.takenMeters === 0) || t.issueId === r.id)
    .map((t) => ({ thaanNo: t.thaanNo, meters: t.meters, yards: r.unit === 'YARD' ? t.yards : null, width: t.width ?? inward.width ?? null, selected: mine.has(t.thaanNo) })) : [];
  out.editBalanceMeters = out.canEdit && !thaans.length ? r2(inward.inwardMeters - inward.outwardMeters + (r.cancelledAt ? 0 : r.meters)) : null;
  return out;
}

/** The cards a linked issue can point at: any SO card of the company (not a fabric return), newest first. */
async function linkCards(req, { customerId, search, limit }) {
  const where = { companyId: req.user.companyId, isGreyReturn: false };
  if (customerId) where.customerId = customerId;
  if (search && /^\d+$/.test(search)) where.cardNo = Number(search);
  const cards = await SoCard.findAll({ where, include: [{ model: Customer, as: 'customer', attributes: ['id', 'code', 'name'], paranoid: false }], order: [['cardNo', 'DESC']], limit });
  return {
    data: cards.map((c) => ({ id: c.id, cardNo: c.cardNo, cardLabel: soLabel(c.cardNo, false), cardDate: c.cardDate, status: c.status, totalMeters: c.totalMeters, customer: c.customer ? { id: c.customer.id, code: c.customer.code, name: c.customer.name } : { id: c.customerId } })),
  };
}

/**
 * Gives the cloth of an ISSUED issue back to the entry's stock and removes its lot, inside the caller's transaction.
 * The cloth must be on no SO card (422 ISSUE_IN_USE otherwise). The issue row itself is left to the caller (delete it, mark it returned, or issue it again).
 */
async function release(req, issueRow, transaction) {
  const lot = await GreyLot.findOne({ where: { id: issueRow.greyLotId }, lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
  if (lot.outwardMeters > 0) {
    const cards = (await cardsOf([lot.id], transaction)).get(lot.id) || [];
    throw AppError.rule('ISSUE_IN_USE', `${lot.outwardMeters} m of this cloth are on an SO card; cancel the card first`, { soCards: cards.map((c) => ({ id: c.id, cardLabel: soLabel(c.cardNo, c.isGreyReturn) })) });
  }
  const inward = await FabricInward.findOne({ where: { id: issueRow.fabricInwardId }, lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
  await FabricInwardThaan.update({ status: 'IN_STOCK', takenMeters: 0, issueId: null }, { where: { issueId: issueRow.id }, transaction });
  inward.outwardMeters = r2(inward.outwardMeters - issueRow.meters);
  await inward.save({ transaction });
  await GreyLotThaan.destroy({ where: { lotId: lot.id }, transaction });
  await lot.destroy({ transaction });
}

/**
 * Take cloth out of a fabric inward for a customer (existing = null), or change an issue and issue it again (existing = the issue row).
 *   { fabricInwardId, thaanNos: [1, 2] | meters (+ pieces), customerId and/or linkedSoCardId (null = no link), issueDate, remarks }
 * Editing: an ISSUED issue (on no SO card) first gives its cloth back, so its own thaans count as free; a RETURNED issue is already back in the stock.
 * Fields that are not sent keep their old value (also the thaans / meters the issue held). The issue keeps its number; it gets a NEW lot and is ISSUED again.
 */
async function build(req, data, transaction, existing) {
  const companyId = req.user.companyId;
  if (existing && data.fabricInwardId && data.fabricInwardId !== existing.fabricInwardId) throw AppError.rule('INWARD_NOT_CHANGEABLE', 'The fabric inward of an issue cannot change: delete the issue and make a new one');
  const before = existing ? await loadOne(req, existing.id, transaction) : null;
  if (existing && !existing.cancelledAt) await release(req, existing, transaction);
  const inward = await FabricInward.findOne({ where: { id: existing ? existing.fabricInwardId : data.fabricInwardId, companyId }, lock: transaction.LOCK.UPDATE, transaction });
  if (!inward) throw AppError.notFound('Fabric inward');
  if (!inward.isApproved) throw AppError.rule('INWARD_NOT_APPROVED', 'Approve the fabric inward first: only approved cloth is in the stock');
  if (!inward.isActive) throw AppError.rule('INWARD_INACTIVE', 'This fabric inward is switched off');
  const issueDate = data.issueDate || (existing ? String(existing.issueDate).slice(0, 10) : today());
  if (String(issueDate) < String(inward.inwardDate).slice(0, 10)) throw AppError.rule('ISSUE_BEFORE_INWARD', `The cloth arrived on ${String(inward.inwardDate).slice(0, 10)}: it cannot be issued before that`);

  // the party: the linked card's customer, else the one chosen (editing: the old one when nothing is sent)
  const linkedId = data.linkedSoCardId === undefined ? (existing ? existing.linkedSoCardId : null) : data.linkedSoCardId;
  let customerId = data.customerId;
  let linked = null;
  if (linkedId) {
    linked = await SoCard.findOne({ where: { id: linkedId, companyId }, transaction });
    if (!linked) throw AppError.rule('UNKNOWN_SO_CARD', 'The SO card to link was not found');
    if (customerId && customerId !== linked.customerId) throw AppError.rule('LINK_OTHER_CUSTOMER', 'The linked SO card belongs to another customer');
    customerId = linked.customerId;
  } else if (!customerId && existing) {
    customerId = existing.customerId;
  }
  if (!customerId) throw AppError.rule('CUSTOMER_REQUIRED', 'Pick the customer this cloth is for, or link the SO card it replaces');
  const customer = await Customer.findOne({ where: { id: customerId, companyId }, transaction });
  if (!customer) throw AppError.rule('UNKNOWN_CUSTOMER', 'Customer not found');
  if (!customer.isActive) throw AppError.rule('CUSTOMER_INACTIVE', 'This customer is switched off');

  const all = await FabricInwardThaan.findAll({ where: { inwardId: inward.id }, order: [['thaanNo', 'ASC']], lock: transaction.LOCK.UPDATE, transaction });
  let { thaanNos, meters } = data;
  if (existing && !thaanNos && !meters) { // nothing sent: the same cloth as before
    if (all.length) thaanNos = (existing.thaanNos || []).length ? existing.thaanNos : undefined;
    else meters = Number(existing.meters);
  }
  let rows = [];
  let pieces;
  if (all.length) {
    if (!thaanNos) throw AppError.rule('PICK_THAANS', 'This entry has a thaan list; pick the thaans to issue');
    rows = all.filter((t) => thaanNos.includes(t.thaanNo));
    if (rows.length !== new Set(thaanNos).size) throw AppError.rule('UNKNOWN_THAAN', 'Some thaan numbers are not in this entry');
    const gone = rows.find((t) => t.status !== 'IN_STOCK' || t.takenMeters > 0);
    if (gone) throw AppError.rule('THAAN_TAKEN', `Thaan ${gone.thaanNo} has already been issued`);
    meters = r2(rows.reduce((t, x) => t + x.meters, 0));
    pieces = rows.length;
  } else {
    if (thaanNos) throw AppError.rule('UNKNOWN_THAAN', 'This entry has no thaan list: give the meters');
    if (!meters) throw AppError.rule('QTY_REQUIRED', 'Give the meters to issue');
    meters = r2(meters);
    pieces = data.pieces ?? (existing && meters === Number(existing.meters) ? existing.pieces : 0);
  }
  const balance = r2(inward.inwardMeters - inward.outwardMeters);
  if (meters > balance) throw AppError.rule('NOT_ENOUGH_METERS', `Only ${balance} m of this entry are still in the store`, { balanceMeters: balance });
  const remarks = data.remarks !== undefined ? (data.remarks || null) : (existing ? existing.remarks : null);

  const issueId = existing ? existing.id : crypto.randomUUID();
  const lot = await greyLots.createFromStore(req, {
    fabricIssueId: issueId, inwardDate: issueDate, customerId, qualityId: inward.qualityId, dcNo: inward.dcNo, unit: inward.unit,
    thaans: rows.length ? rows.map((t) => ({ meters: t.meters, yards: t.yards, width: t.width ?? inward.width })) : null,
    inwardMeters: meters, pieces, glm: inward.glm, gsm: inward.gsm, width: inward.width,
    partyRef: `Store fabric ${inwardText(inward.inwardNo)}`, remarks,
  }, transaction);
  const held = rows.map((t) => t.thaanNo);
  if (existing) {
    Object.assign(existing, { issueDate, customerId, linkedSoCardId: linked ? linked.id : null, greyLotId: lot.id, meters, pieces, remarks, thaanNos: held, cancelledAt: null, cancelledById: null, endKind: null });
    await existing.save({ transaction });
  } else {
    const issueNo = await counters.take(companyId, NO, async () => ((await FabricIssue.max('issueNo', { where: { companyId }, transaction })) || 0) + 1, transaction);
    await FabricIssue.create({
      id: issueId, companyId, issueNo, issueDate, fabricInwardId: inward.id, customerId, linkedSoCardId: linked ? linked.id : null, greyLotId: lot.id,
      meters, pieces, thaanNos: held, remarks, createdById: req.user.id,
    }, { transaction });
  }
  for (const t of rows) Object.assign(t, { status: 'ISSUED', takenMeters: t.meters, issueId });
  for (const t of rows) await t.save({ transaction });
  inward.outwardMeters = r2(inward.outwardMeters + meters);
  await inward.save({ transaction });
  const after = await loadOne(req, issueId, transaction);
  await audit.log(req, { action: existing ? 'FABRIC_ISSUE_EDITED' : 'FABRIC_ISSUED', entityType: 'FabricIssue', entityId: issueId, before, after }, { transaction });
  return { ...after, greyLotId: lot.id };
}

const issue = (req, data) => sequelize.transaction((transaction) => build(req, data, transaction, null));

async function findIssue(req, id, transaction) {
  const issueRow = await FabricIssue.findOne({ where: { id, companyId: req.user.companyId }, lock: transaction.LOCK.UPDATE, transaction });
  if (!issueRow) throw AppError.notFound('Fabric issue');
  return issueRow;
}

/** Edit an issue and issue it again: a RETURNED issue, or an ISSUED one that is on no SO card (422 ISSUE_IN_USE otherwise). */
const edit = (req, id, data) => sequelize.transaction(async (transaction) => build(req, data, transaction, await findIssue(req, id, transaction)));

/** Deletes the issue row for good (the cloth is back in the stock, nothing is left in the ledger). */
async function removeRow(req, issueRow, transaction) {
  const before = await loadOne(req, issueRow.id, transaction);
  if (!issueRow.cancelledAt) await release(req, issueRow, transaction);
  await issueRow.destroy({ transaction });
  await audit.log(req, { action: 'FABRIC_ISSUE_DELETED', entityType: 'FabricIssue', entityId: before.id, before }, { transaction });
  return { id: before.id, issueNo: before.issueNo, deleted: true };
}

/** Delete an ISSUED issue (cloth on no SO card) or a RETURNED one. The thaans go back to the stock; the issue leaves the list, the totals and the ledger. */
const cancel = (req, id) => sequelize.transaction(async (transaction) => removeRow(req, await findIssue(req, id, transaction), transaction));

/**
 * An SO card was cancelled: the store cloth of its lots goes back to the store and the issue stays as RETURNED (kind RETURNED),
 * or the issue is deleted (kind DELETE). A lot that another SO card still uses stays as it is. Returns what happened per lot.
 */
async function releaseLots(req, lotIds, kind, transaction) {
  const out = [];
  for (const lotId of lotIds) {
    const issueRow = await FabricIssue.findOne({ where: { greyLotId: lotId, companyId: req.user.companyId, cancelledAt: null }, lock: transaction.LOCK.UPDATE, transaction });
    if (!issueRow) continue;
    const lot = await GreyLot.findOne({ where: { id: lotId }, lock: transaction.LOCK.UPDATE, paranoid: false, transaction });
    if (lot.outwardMeters > 0) { out.push({ issueNo: issueRow.issueNo, result: 'STILL_USED' }); continue; }
    if (kind === 'DELETE') await removeRow(req, issueRow, transaction);
    else {
      const before = await loadOne(req, issueRow.id, transaction);
      await release(req, issueRow, transaction);
      Object.assign(issueRow, { cancelledAt: new Date(), cancelledById: req.user.id, endKind: 'RETURNED' });
      await issueRow.save({ transaction });
      await audit.log(req, { action: 'FABRIC_ISSUE_RETURNED', entityType: 'FabricIssue', entityId: issueRow.id, before, after: await loadOne(req, issueRow.id, transaction) }, { transaction });
    }
    out.push({ issueNo: issueRow.issueNo, result: kind });
  }
  return out;
}

function filtersOf(req, f) {
  const parts = ['fi."companyId" = :cid'];
  const r = { cid: req.user.companyId };
  const add = (cond, key, val) => { if (val !== undefined && val !== null && val !== '') { parts.push(cond); r[key] = val; } };
  add('fi."customerId" = :customerId', 'customerId', f.customerId);
  add('fi."fabricInwardId" = :inwardId', 'inwardId', f.fabricInwardId);
  add('fin."vendorId" = :vendorId', 'vendorId', f.vendorId);
  add('fin."qualityId" = :qualityId', 'qualityId', f.qualityId);
  add('fi."linkedSoCardId" = :linked', 'linked', f.linkedSoCardId);
  add('fi."issueDate" >= :dateFrom', 'dateFrom', f.dateFrom);
  add('fi."issueDate" <= :dateTo', 'dateTo', f.dateTo);
  if (f.linked === true) parts.push('fi."linkedSoCardId" IS NOT NULL');
  if (f.linked === false) parts.push('fi."linkedSoCardId" IS NULL');
  if (f.status === 'ISSUED') parts.push('fi."cancelledAt" IS NULL');
  if (f.status === 'RETURNED') parts.push('fi."cancelledAt" IS NOT NULL');
  if (f.search) {
    r.s = `%${f.search}%`;
    const n = /^\d+$/.test(f.search) ? ' OR fi."issueNo" = :n OR gl."lotNo" = :n OR lc."cardNo" = :n OR fin."inwardNo" = :n' : '';
    if (n) r.n = Number(f.search);
    parts.push(`(c.name ILIKE :s OR v.name ILIKE :s OR ql.name ILIKE :s OR fin."dcNo" ILIKE :s${n})`);
  }
  return { where: parts.join(' AND '), r };
}

const GROUPS = {
  customer: { key: 'c.id', label: 'c.name', name: 'customer' },
  vendor: { key: 'v.id', label: 'v.name', name: 'vendor' },
  quality: { key: 'ql.id', label: 'ql.name', name: 'quality' },
  linkedCard: { key: 'COALESCE(lc.id::text, \'none\')', label: 'CASE WHEN lc.id IS NULL THEN \'Not linked\' ELSE \'SO \' || lc."cardNo" END', name: 'linked card' },
};

/** The issues, newest first; with totals (cancelled ones are not counted) and, with groupBy, the meters per customer / vendor / quality / linked card. */
async function list(req, f) {
  const { where, r } = filtersOf(req, f);
  const live = `${where} AND fi."cancelledAt" IS NULL`;
  const [rows, [tot], groups] = await Promise.all([
    q(`SELECT ${COLS} ${BASE} WHERE ${where} ORDER BY fi."issueNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit: f.limit, offset: (f.page - 1) * f.limit }),
    q(`SELECT count(*)::int AS n, COALESCE(sum(fi.meters), 0)::float AS meters, COALESCE(sum(fi.pieces), 0)::int AS pieces, count(fi."linkedSoCardId")::int AS linked ${BASE} WHERE ${live}`, r),
    f.groupBy ? q(`SELECT ${GROUPS[f.groupBy].key} AS key, ${GROUPS[f.groupBy].label} AS label, count(*)::int AS issues, sum(fi.meters)::float AS meters, sum(fi.pieces)::int AS pieces
      ${BASE} WHERE ${live} GROUP BY 1, 2 ORDER BY sum(fi.meters) DESC`, r) : Promise.resolve(null),
  ]);
  const [{ n: total }] = await q(`SELECT count(*)::int AS n ${BASE} WHERE ${where}`, r);
  const cards = await cardsOf(rows.map((x) => x.lotId));
  return {
    data: rows.map((x) => row(x, cards.get(x.lotId) || [])),
    totals: { issues: tot.n, meters: r2(tot.meters), yards: toYards(tot.meters), pieces: tot.pieces, linkedIssues: tot.linked, unlinkedIssues: tot.n - tot.linked },
    ...(groups ? { groupBy: f.groupBy, groups: groups.map((g) => ({ key: g.key, label: g.label, issues: g.issues, meters: r2(g.meters), pieces: g.pieces })) } : {}),
    page: f.page, limit: f.limit, total,
  };
}

const get = (req, id) => loadOne(req, id);

/**
 * The Fabric Store cloth ledger: every movement in date order with a running balance (meters).
 *   INWARD      +  approved fabric inward from a vendor
 *   ISSUE       -  cloth issued to a customer (SO card)
 *   ISSUE_UNDO  +  an issue that was cancelled (the cloth is back)
 * Filters: fabricInwardId, vendorId, qualityId, customerId (issues only), dateFrom / dateTo. Rows before dateFrom are summed into `opening`.
 */
async function ledger(req, f) {
  const r = { cid: req.user.companyId };
  const fin = ['fin."companyId" = :cid', 'fin."deletedAt" IS NULL'];
  if (f.fabricInwardId) { fin.push('fin.id = :inwardId'); r.inwardId = f.fabricInwardId; }
  if (f.vendorId) { fin.push('fin."vendorId" = :vendorId'); r.vendorId = f.vendorId; }
  if (f.qualityId) { fin.push('fin."qualityId" = :qualityId'); r.qualityId = f.qualityId; }
  const finWhere = fin.join(' AND ');
  const issueCustomer = f.customerId ? ' AND fi."customerId" = :customerId' : '';
  if (f.customerId) r.customerId = f.customerId;
  const moves = await q(`
    SELECT * FROM (
      SELECT 'INWARD' AS kind, fin."inwardDate"::date AS day, fin."createdAt" AS ts, fin.id AS "inwardId", fin."inwardNo", fin."inwardNo" AS "refNo", fin."inwardMeters"::float AS "inMeters", 0::float AS "outMeters",
        v.name AS party, ql.name AS quality, fin."dcNo" AS note, NULL::int AS "cardNo", NULL::boolean AS "cardFr", NULL::int AS "lotNo"
      FROM fabric_inwards fin JOIN vendors v ON v.id = fin."vendorId" JOIN qualities ql ON ql.id = fin."qualityId"
      WHERE ${finWhere} AND fin."isApproved" AND ${f.customerId ? 'false' : 'true'}
      UNION ALL
      SELECT 'ISSUE', fi."issueDate"::date, fi."createdAt", fin.id, fin."inwardNo", fi."issueNo", 0, fi.meters::float, c.name, ql.name, fi.remarks, lc."cardNo", lc."isGreyReturn", gl."lotNo"
      FROM fabric_issues fi JOIN fabric_inwards fin ON fin.id = fi."fabricInwardId" JOIN qualities ql ON ql.id = fin."qualityId" JOIN customers c ON c.id = fi."customerId"
        JOIN grey_lots gl ON gl.id = fi."greyLotId" LEFT JOIN so_cards lc ON lc.id = fi."linkedSoCardId"
      WHERE ${finWhere}${issueCustomer}
      UNION ALL
      SELECT 'ISSUE_RETURN', fi."cancelledAt"::date, fi."cancelledAt", fin.id, fin."inwardNo", fi."issueNo", fi.meters::float, 0, c.name, ql.name, fi.remarks, lc."cardNo", lc."isGreyReturn", gl."lotNo"
      FROM fabric_issues fi JOIN fabric_inwards fin ON fin.id = fi."fabricInwardId" JOIN qualities ql ON ql.id = fin."qualityId" JOIN customers c ON c.id = fi."customerId"
        JOIN grey_lots gl ON gl.id = fi."greyLotId" LEFT JOIN so_cards lc ON lc.id = fi."linkedSoCardId"
      WHERE ${finWhere}${issueCustomer} AND fi."cancelledAt" IS NOT NULL
    ) m ORDER BY day, ts, kind`, r);
  let opening = 0;
  let running = 0;
  let totalIn = 0;
  let totalOut = 0;
  const out = [];
  for (const m of moves) {
    const day = String(m.day).slice(0, 10);
    if (f.dateFrom && day < f.dateFrom) { opening = r2(opening + m.inMeters - m.outMeters); continue; }
    if (f.dateTo && day > f.dateTo) continue;
    out.push(m);
  }
  running = opening;
  const rows = out.map((m) => {
    running = r2(running + m.inMeters - m.outMeters);
    totalIn = r2(totalIn + m.inMeters);
    totalOut = r2(totalOut + m.outMeters);
    const label = { INWARD: 'Fabric inward', ISSUE: 'Issued to SO card', ISSUE_RETURN: 'Returned to store' }[m.kind];
    return {
      date: String(m.day).slice(0, 10), kind: m.kind, kindText: label,
      refText: m.kind === 'INWARD' ? inwardText(m.refNo) : issueText(m.refNo), inwardId: m.inwardId, inwardText: inwardText(m.inwardNo),
      party: m.party, quality: m.quality, note: m.note, lotNo: m.lotNo, linkedSoCard: m.cardNo ? soLabel(m.cardNo, m.cardFr) : null,
      inMeters: m.inMeters, outMeters: m.outMeters, balanceMeters: running,
    };
  });
  const start = (f.page - 1) * f.limit;
  return { opening, totals: { inMeters: totalIn, outMeters: totalOut }, closing: running, data: rows.slice(start, start + f.limit), page: f.page, limit: f.limit, total: rows.length };
}

module.exports = { releaseLots, issue, edit, cancel, list, get, ledger, linkCards };
