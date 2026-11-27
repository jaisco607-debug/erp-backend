// SO card cost and margin (owner plan N-C1). A read-only report: it never posts to the accounts, it only adds up what is already recorded.
//
// Cost of an SO card, each part on its own:
//   grey cloth        cloth bought from the Fabric Store: the meters x the rate it was bought at. The customer's own cloth costs the mill nothing (NOT_APPLICABLE).
//   chemicals         the chemicals sent to the card's jobs (chemical requests, at the store average rate)
//   yarn              the yarn the departments used for the card's jobs
//   department charge every PROCESS / FOLDING department the cloth went through: its meters x the rate of that department on the day of the job (Settings > Process rates)
//   packing           the Packing department: its meters x its rate
// A part with nothing recorded is NOT_ENTERED (null), not 0, when the cloth did go where a cost is expected; PARTLY when only some departments have a rate.
// Revenue (before tax): the approved sales invoice lines of the card's packing lists; a final packing list with no approved invoice yet counts at its packed value (meters x its rates).
// Margin = revenue - cost, in money and percent. Only people with the accounting service (ACC_REPORTS or ACC_SALES) can open it.
const AppError = require('../utils/AppError');
const { _x } = require('./reportService');
const processRates = require('./processRateService');

const { q, round, col, section, respond, chemLines, yarnLines, needAnyService } = _x;
const ROW_CAP = 5000;
const PARTS = ['grey', 'chemicals', 'yarn', 'departmentCharges', 'packing'];
const PART_TEXT = { grey: 'Grey cloth', chemicals: 'Chemicals', yarn: 'Yarn', departmentCharges: 'Department charges', packing: 'Packing' };
const ids0 = (ids) => (ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);

const part = (amount, status, extra = {}) => ({ amount: amount === null ? null : round(amount), status, ...extra });

/** Everything about the cards: cost parts, revenue, margin; details too when `withDetail`. */
async function build(companyId, cards, withDetail) {
  const ids = ids0(cards.map((c) => c.id));
  const rep = { cid: companyId, ids };
  const [lots, jobs, lists, listLines, invoiced, chem, yarn, rates] = await Promise.all([
    q(`SELECT scl."soCardId", gl."lotNo", gl.source, scl.meters::float AS meters,
         CASE WHEN gl.source = 'STORE' THEN (SELECT fin.amount::float / NULLIF(fin."inwardMeters", 0) FROM fabric_issues fis JOIN fabric_inwards fin ON fin.id = fis."fabricInwardId"
                                              WHERE fis."greyLotId" = gl.id AND fis."cancelledAt" IS NULL AND fin."companyId" = :cid LIMIT 1) END AS "perMeter"
       FROM so_card_lots scl JOIN grey_lots gl ON gl.id = scl."greyLotId" AND gl."companyId" = :cid WHERE scl."soCardId" IN (:ids) ORDER BY gl."lotNo"`, rep),
    q(`SELECT ji."soCardId", j.id AS "jobId", j."jobNo", j."departmentId", svc_name(s.id, j."companyId", s.name) AS department, s.kind, to_char(j."jobDate", 'YYYY-MM-DD') AS "jobDate", SUM(ji.meters)::float AS meters
       FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' AND j."companyId" = :cid JOIN services s ON s.id = j."departmentId"
       WHERE ji."soCardId" IN (:ids) GROUP BY ji."soCardId", j.id, s.id, s.name, s.kind ORDER BY j."jobNo"`, rep),
    q(`SELECT pl.id, pl."soCardId", pl."listNo", pl."rateA"::float AS "rateA", pl."rateB"::float AS "rateB", pl."rateCP"::float AS "rateCP"
       FROM packing_lists pl WHERE pl."companyId" = :cid AND pl.status = 'FINAL' AND pl."soCardId" IN (:ids) ORDER BY pl."listNo"`, rep),
    q(`SELECT l."packingListId", l.grade, SUM(l.meters)::float AS meters FROM packing_list_lines l JOIN packing_lists pl ON pl.id = l."packingListId" AND pl."companyId" = :cid
       WHERE pl.status = 'FINAL' AND pl."soCardId" IN (:ids) GROUP BY l."packingListId", l.grade`, rep),
    q(`SELECT sil."packingListId", SUM(sil.amount)::float AS amount, MIN(si."invoiceNo") AS "invoiceNo" FROM sales_invoice_lines sil JOIN sales_invoices si ON si.id = sil."invoiceId" AND si.status = 'APPROVED' AND si."companyId" = :cid
       JOIN packing_lists pl ON pl.id = sil."packingListId" AND pl."companyId" = :cid WHERE pl."soCardId" IN (:ids) GROUP BY sil."packingListId"`, rep),
    chemLines(companyId, {}),
    yarnLines(companyId, {}),
    processRates.ratesOf(companyId),
  ]);
  const inv = new Map(invoiced.map((r) => [r.packingListId, r]));
  const qtyOf = (listId, grade) => (listLines.find((l) => l.packingListId === listId && l.grade === grade) || {}).meters || 0;

  return cards.map((c) => {
    const myLots = lots.filter((l) => l.soCardId === c.id);
    const myJobs = jobs.filter((j) => j.soCardId === c.id);
    const myLists = lists.filter((l) => l.soCardId === c.id);

    // grey cloth
    const greyLines = myLots.map((l) => ({ lotNo: l.lotNo, source: l.source, meters: l.meters, perMeter: l.perMeter ?? null, amount: l.source === 'STORE' && l.perMeter != null ? round(l.meters * l.perMeter) : null }));
    const storeLots = greyLines.filter((l) => l.source === 'STORE');
    const grey = !storeLots.length ? part(0, 'NOT_APPLICABLE', { note: "The customer's own cloth costs nothing" })
      : storeLots.every((l) => l.amount !== null) ? part(storeLots.reduce((t, l) => t + l.amount, 0), 'ENTERED')
        : storeLots.some((l) => l.amount !== null) ? part(storeLots.reduce((t, l) => t + (l.amount || 0), 0), 'PARTLY', { missing: storeLots.filter((l) => l.amount === null).map((l) => `Lot ${l.lotNo}`) })
          : part(null, 'NOT_ENTERED', { note: 'The fabric bought for this cloth has no rate' });

    // chemicals and yarn
    const myChem = chem.filter((l) => l.soCardId === c.id);
    const goneToProcess = myJobs.some((j) => j.kind === 'PROCESS');
    const chemicals = myChem.length ? part(myChem.reduce((t, l) => t + l.amount, 0), 'ENTERED') : (goneToProcess ? part(null, 'NOT_ENTERED', { note: 'No chemical was sent for this card' }) : part(0, 'NOT_APPLICABLE'));
    const myYarn = yarn.filter((l) => l.soCardId === c.id);
    const yarnPart = myYarn.length ? part(myYarn.reduce((t, l) => t + l.amount, 0), 'ENTERED') : part(0, 'NOT_APPLICABLE');

    // department charges and packing: meters x the rate of the day of the job
    const jobLines = myJobs.map((j) => {
      const rate = processRates.rateOn(rates.get(j.departmentId), j.jobDate);
      return { jobId: j.jobId, jobNo: j.jobNo, departmentId: j.departmentId, department: j.department, kind: j.kind, jobDate: j.jobDate, meters: j.meters, ratePerMeter: rate, charge: rate === null ? null : round(j.meters * rate) };
    });
    const charges = (kinds) => {
      const mine = jobLines.filter((j) => kinds.includes(j.kind));
      if (!mine.length) return part(0, 'NOT_APPLICABLE');
      const known = mine.filter((j) => j.charge !== null);
      const missing = [...new Set(mine.filter((j) => j.charge === null).map((j) => j.department))];
      if (!known.length) return part(null, 'NOT_ENTERED', { missing, note: 'No rate is set for these departments' });
      return part(known.reduce((t, j) => t + j.charge, 0), missing.length ? 'PARTLY' : 'ENTERED', missing.length ? { missing } : {});
    };
    const departmentCharges = charges(['PROCESS', 'FOLDING']);
    const packing = charges(['PACKING']);

    const parts = { grey, chemicals, yarn: yarnPart, departmentCharges, packing };
    const totalCost = round(PARTS.reduce((t, k) => t + (parts[k].amount || 0), 0));
    const missingParts = PARTS.filter((k) => ['NOT_ENTERED', 'PARTLY'].includes(parts[k].status));

    // revenue: the approved invoice of a packing list, else its packed value
    const listRows = myLists.map((l) => {
      const packed = round(qtyOf(l.id, 'A') * l.rateA + qtyOf(l.id, 'B') * l.rateB + qtyOf(l.id, 'CP') * l.rateCP);
      const i = inv.get(l.id);
      return { listNo: l.listNo, packedValue: packed, invoiceNo: i ? i.invoiceNo : null, invoicedAmount: i ? round(i.amount) : null, amount: i ? round(i.amount) : packed, source: i ? 'INVOICE' : 'PACKED' };
    });
    const sources = new Set(listRows.map((l) => l.source));
    const revenueSource = !listRows.length ? 'NONE' : sources.size > 1 ? 'MIXED' : [...sources][0];
    const revenue = round(listRows.reduce((t, l) => t + l.amount, 0));
    const margin = revenueSource === 'NONE' ? null : round(revenue - totalCost);

    const row = {
      soCardId: c.id, soNo: c.cardNo, cardDate: c.cardDate, party: c.party, customerId: c.customerId, quality: c.quality, article: c.article, meters: c.meters, tag: c.isGreyReturn ? 'Fabric return grey' : '',
      revenue: revenueSource === 'NONE' ? null : revenue, revenueSource,
      greyCost: grey.amount, chemicalCost: chemicals.amount, yarnCost: yarnPart.amount, departmentCost: departmentCharges.amount, packingCost: packing.amount,
      totalCost, costPerMeter: c.meters ? round(totalCost / c.meters) : 0, margin, marginPercent: margin !== null && revenue > 0 ? round((margin / revenue) * 100, 2) : null,
      costStatus: missingParts.length ? 'Cost not complete' : 'Cost complete', costComplete: !missingParts.length, missingParts, parts,
    };
    if (withDetail) {
      row.detail = {
        greyLots: greyLines,
        jobs: jobLines,
        chemicals: Object.values(myChem.reduce((m, l) => { const x = (m[l.itemId] ||= { chemical: l.chemical, unit: l.unit, qty: 0, amount: 0 }); x.qty = round(x.qty + l.qty, 3); x.amount = round(x.amount + l.amount); return m; }, {})),
        yarn: Object.values(myYarn.reduce((m, l) => { const k = `${l.yarnName}|${l.brand || ''}`; const x = (m[k] ||= { yarn: l.brand ? `${l.yarnName} - ${l.brand}` : l.yarnName, lbs: 0, amount: 0 }); x.lbs = round(x.lbs + l.lbs); x.amount = round(x.amount + l.amount); return m; }, {})),
        packingLists: listRows,
      };
    }
    return row;
  });
}

async function cardsOf(req, f, extra = '', rep = {}) {
  const where = ['sc."companyId" = :cid', 'sc."deletedAt" IS NULL'];
  const r = { cid: req.user.companyId, cap: ROW_CAP + 1, ...rep };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); r.customerId = f.customerId; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); r.soNo = f.soNo; }
  if (f.qualityId) { where.push('sc."qualityId" = :qualityId'); r.qualityId = f.qualityId; }
  if (f.dateFrom) { where.push('sc."cardDate" >= :dateFrom'); r.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('sc."cardDate" <= :dateTo'); r.dateTo = f.dateTo; }
  const cards = await q(`SELECT sc.id, sc."cardNo", to_char(sc."cardDate", 'YYYY-MM-DD') AS "cardDate", sc."isGreyReturn", sc."customerId", cu.name AS party, qu.name AS quality, sc.article, sc."totalMeters"::float AS meters
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" AND cu."companyId" = :cid LEFT JOIN qualities qu ON qu.id = sc."qualityId"
    WHERE ${where.join(' AND ')}${extra} ORDER BY sc."cardNo" DESC LIMIT :cap`, r);
  if (cards.length > ROW_CAP) throw AppError.rule('REPORT_TOO_BIG', `The report has more than ${ROW_CAP} SO cards: choose a shorter period or a customer`, { cap: ROW_CAP });
  return cards;
}

/** GET /reports/so-card-margin?dateFrom&dateTo&customerId&soNo */
async function report(req, f) {
  await needAnyService(req, ['ACC_REPORTS', 'ACC_SALES']);
  const rows = await build(req.user.companyId, await cardsOf(req, f), false);
  const money = (key, label) => col(key, label, 'money');
  const columns = [col('soNo', 'SO#', 'number'), col('cardDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'), col('article', 'Article'), col('meters', 'Meters', 'number'),
    money('revenue', 'Revenue (before tax)'), col('revenueSource', 'Revenue from', 'tag'), money('greyCost', 'Grey cloth'), money('chemicalCost', 'Chemicals'), money('yarnCost', 'Yarn'), money('departmentCost', 'Department charges'),
    money('packingCost', 'Packing'), money('totalCost', 'Total cost'), money('costPerMeter', 'Cost / m'), money('margin', 'Margin'), col('marginPercent', 'Margin %', 'number'), col('costStatus', 'Cost', 'tag'), col('tag', 'Tag', 'tag')];
  const sec = section('margin', 'SO card cost and margin', columns, rows.map(({ parts, ...r }) => ({ ...r, parts })), ['meters', 'revenue', 'greyCost', 'chemicalCost', 'yarnCost', 'departmentCost', 'packingCost', 'totalCost', 'margin']);
  sec.totals.marginPercent = sec.totals.revenue > 0 && rows.some((r) => r.margin !== null) ? round((sec.totals.margin / sec.totals.revenue) * 100, 2) : null;
  sec.totals.incompleteCards = rows.filter((r) => !r.costComplete).length;
  sec.totals.negativeCards = rows.filter((r) => r.margin !== null && r.margin < 0).length;
  const out = respond('SO card cost and margin', f, [sec], f);
  out.partsText = PART_TEXT;
  return out;
}

/** GET /reports/so-card-margin/:soCardId: one card with the parts behind each number (the drill-down panel). */
async function detail(req, soCardId) {
  await needAnyService(req, ['ACC_REPORTS', 'ACC_SALES']);
  const cards = await cardsOf(req, {}, ' AND sc.id = :soCardId', { soCardId });
  if (!cards.length) throw AppError.notFound('SO card');
  const [row] = await build(req.user.companyId, cards, true);
  return { ...row, partsText: PART_TEXT };
}

module.exports = { report, detail };
