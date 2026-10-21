// Fabric return grey (owner 2026-10-19). A party sent e.g. 50 thaan, then wants 20 back unprocessed.
// The Grey Store picks those thaans and they go straight to Folding on a special SO card
// (isGreyReturn). Folding can only pass them to Packing (no grading, no departments); Packing makes
// the packing list and the gate pass. The tag "Fabric return grey" shows on every screen.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const { companyServices } = require('./accessService');
const soCards = require('./soCardService');

/** lots: [{ greyLotId, thaanNos | thaans [{ thaanNo, meters }] | meters }], same lines as an SO card. */
async function fabricReturn(req, { lots, cardDate, sentThrough, remarks }) {
  const folding = (await companyServices(req.user.companyId)).find((s) => s.kind === 'FOLDING');
  if (!folding) throw AppError.rule('NO_FOLDING', 'Your company does not have the Folding department');
  return soCards.create(req, {
    lots, cardDate: cardDate || today(), departmentId: folding.id, sentThrough,
    remarks: remarks || 'Fabric return grey', description: 'FABRIC RETURN GREY', isGreyReturn: true, desk: 'GREY_STORE',
  });
}

const STATUS_TEXT = { IN_WAY: 'In-Way', QUEUE: 'Queue', PENDING: 'Pending', PROCESSING: 'Processing', COMPLETE: 'Complete' };
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/**
 * Where each fabric return is, with its packing lists and gate passes, so the Grey Store screen
 * (Production > Outwards > Fabric Returns) needs nothing from the SO Card, Folding or Packing services.
 *   stage: NOT_SENT | IN_FOLDING | IN_PACKING | PACKING_LIST | DISPATCHED
 */
async function decorate(cards) {
  if (!cards.length) return cards;
  const ids = cards.map((c) => c.id);
  const lists = await q(`
    SELECT p."soCardId", p.id, p."listNo", p."listDate", p.status, COALESCE(SUM(pl.meters), 0)::float AS meters, COUNT(pl.id)::int AS thaans,
           g."gatePassNo", g."passDate", g."vehicleNo", g."driverName", g.destination
    FROM packing_lists p LEFT JOIN packing_list_lines pl ON pl."packingListId" = p.id LEFT JOIN gate_passes g ON g."packingListId" = p.id
    WHERE p."soCardId" IN (:ids) GROUP BY p.id, g.id ORDER BY p."listNo"`, { ids });
  const latest = await q(`
    SELECT DISTINCT ON (ji."soCardId") ji."soCardId", s.name AS department, s.kind, j.status
    FROM job_items ji JOIN jobs j ON j.id = ji."jobId" JOIN services s ON s.id = j."departmentId"
    WHERE ji."soCardId" IN (:ids) AND j.status <> 'REJECTED' ORDER BY ji."soCardId", j."createdAt" DESC`, { ids });
  return cards.map((c) => {
    const mine = lists.filter((l) => l.soCardId === c.id).map((l) => ({
      id: l.id, listNo: l.listNo, listDate: l.listDate, status: l.status, statusText: l.status === 'FINAL' ? 'Final' : 'Draft',
      thaans: l.thaans, meters: require('../utils/money').round(l.meters),
      gatePass: l.gatePassNo ? { gatePassNo: l.gatePassNo, passDate: l.passDate, vehicleNo: l.vehicleNo, driverName: l.driverName, destination: l.destination } : null,
    }));
    const job = latest.find((x) => x.soCardId === c.id);
    let stage = 'NOT_SENT';
    let stageText = 'Not sent to Folding yet';
    if (mine.length && mine.every((l) => l.gatePass)) {
      stage = 'DISPATCHED';
      stageText = `Dispatched (gate pass ${mine.map((l) => l.gatePass.gatePassNo).join(', ')})`;
    } else if (mine.length) {
      stage = 'PACKING_LIST';
      stageText = `Packing list ${mine.map((l) => l.listNo).join(', ')} made`;
    } else if (job) {
      stage = job.kind === 'PACKING' ? 'IN_PACKING' : 'IN_FOLDING';
      stageText = `${job.department} (${STATUS_TEXT[job.status]})`;
    }
    return { ...c, stage, stageText, packingLists: mine, gatePassCount: mine.filter((l) => l.gatePass).length };
  });
}

/** Grey Store: the fabric returns made so far, newest first (same card fields as an SO card, plus stage / packing lists / gate passes). */
async function list(req, query) {
  const page = await soCards.list(req, { ...query, isGreyReturn: true });
  return { ...page, data: await decorate(page.data) };
}

async function get(req, id) {
  const card = await soCards.get(req, id);
  if (!card.isGreyReturn) throw AppError.notFound('Fabric return');
  return (await decorate([card]))[0];
}

/** The lot / thaan picker for a new fabric return (the same lots an SO card can take from), and the number it will get (FR-n). */
async function availableLots(req, query) {
  return { ...(await soCards.availableLots(req, query)), ...(await soCards.nextFabricReturnNo(req)) };
}

module.exports = { fabricReturn, list, get, availableLots };
