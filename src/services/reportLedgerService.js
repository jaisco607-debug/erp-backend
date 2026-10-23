// Ledgers (2026-10-23): the cloth's whole journey as dated rows, from every angle.
//   ledger       one row per event (grey in, given back, SO card, department job, packing list, gate pass) with a running
//                grey-store balance. Filter by party, SO card, lot (search) and dates; shows the opening balance of dateFrom.
//   dailyStock   one row per day: grey store opening / in / out / closing, meters sent to departments, packed, dispatched, chemical cost.
// Same answer shape as reportService, so the tab builds the PDF / Excel from `sections`.
const { _x } = require('./reportService');

const { q, round, col, section, respond, chemLines, needAnyService } = _x;
const TAG = 'Fabric return grey (not processed)';
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Every dated event of the company (before filters). */
async function events(companyId, f = {}) {
  const ev = [];
  const cu = f.customerId ? ' AND gl."customerId" = :customerId' : '';
  const rep = { companyId, customerId: f.customerId };
  for (const r of await q(`SELECT gl."inwardDate" AS date, gl."lotNo", gl."dcNo", cu.id AS "customerId", cu.name AS party, gl."inwardMeters"::float AS meters
      FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" WHERE gl."companyId" = :companyId AND gl."deletedAt" IS NULL AND gl."isApproved"${cu}`, rep)) {
    ev.push({ date: ymd(r.date), order: 1, type: 'Grey in', party: r.party, customerId: r.customerId, lotNo: r.lotNo, ref: r.dcNo ? `DC# ${r.dcNo}` : '', greyIn: r.meters, detail: 'Grey received' });
  }
  for (const r of await q(`SELECT r."returnDate" AS date, r."returnNo", r.meters::float AS meters, gl."lotNo", cu.id AS "customerId", cu.name AS party, r."vehicleNo"
      FROM grey_returns r JOIN grey_lots gl ON gl.id = r."lotId" JOIN customers cu ON cu.id = gl."customerId" WHERE r."companyId" = :companyId${cu}`, rep)) {
    ev.push({ date: ymd(r.date), order: 2, type: 'Grey given back', party: r.party, customerId: r.customerId, lotNo: r.lotNo, ref: `Return# ${r.returnNo}`, greyOut: r.meters, detail: r.vehicleNo || '' });
  }
  for (const r of await q(`SELECT sc."cardDate" AS date, sc."cardNo", sc."isGreyReturn", gl."lotNo", cu.id AS "customerId", cu.name AS party, sc.id AS "soCardId", scl.meters::float AS meters
      FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN customers cu ON cu.id = sc."customerId"
      WHERE sc."companyId" = :companyId${cu}`, rep)) {
    ev.push({ date: ymd(r.date), order: 3, type: r.isGreyReturn ? 'Fabric return' : 'SO card', party: r.party, customerId: r.customerId, soCardId: r.soCardId, soNo: r.cardNo, lotNo: r.lotNo,
      ref: r.isGreyReturn ? `FR-${r.cardNo}` : `SO# ${r.cardNo}`, greyOut: r.meters, detail: r.isGreyReturn ? TAG : 'Taken from grey store' });
  }
  const cost = new Map();
  for (const l of await chemLines(companyId, {})) cost.set(`${l.jobId}:${l.soCardId}`, (cost.get(`${l.jobId}:${l.soCardId}`) || 0) + l.amount);
  for (const r of await q(`SELECT j."jobDate" AS date, j."jobNo", j.id AS "jobId", j.status, j."operatorName", s.name AS department, sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn",
      cu.id AS "customerId", cu.name AS party, SUM(ji.meters)::float AS meters, string_agg(DISTINCT gl."lotNo"::text, ', ') AS lots
      FROM jobs j JOIN services s ON s.id = j."departmentId" JOIN job_items ji ON ji."jobId" = j.id JOIN so_cards sc ON sc.id = ji."soCardId" JOIN customers cu ON cu.id = sc."customerId"
      JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN grey_lots gl ON gl.id = scl."greyLotId"
      WHERE j."companyId" = :companyId AND j.status <> 'REJECTED'${cu.replace('gl."customerId"', 'sc."customerId"')}
      GROUP BY j.id, s.name, sc.id, cu.id`, rep)) {
    ev.push({ date: ymd(r.date), order: 4, type: 'Department', party: r.party, customerId: r.customerId, soCardId: r.soCardId, soNo: r.cardNo, lotNo: r.lots, department: r.department, ref: `Job# ${r.jobNo}`,
      deptMeters: r.meters, amount: round(cost.get(`${r.jobId}:${r.soCardId}`) || 0), detail: [r.operatorName ? `Operator ${r.operatorName}` : '', r.isGreyReturn ? TAG : ''].filter(Boolean).join(' | ') });
  }
  for (const r of await q(`SELECT p."listDate" AS date, p."listNo", p.status, sc.id AS "soCardId", sc."cardNo", sc."isGreyReturn", cu.id AS "customerId", cu.name AS party,
      p."rateA"::float AS "rateA", p."rateB"::float AS "rateB", p."rateCP"::float AS "rateCP",
      COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'A'), 0)::float AS a, COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'B'), 0)::float AS b, COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'CP'), 0)::float AS cp,
      g."gatePassNo", g."passDate", g."vehicleNo", string_agg(DISTINCT gl."lotNo"::text, ', ') AS lots
      FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cu ON cu.id = sc."customerId" LEFT JOIN packing_list_lines l ON l."packingListId" = p.id
      LEFT JOIN grey_lots gl ON gl.id = l."greyLotId" LEFT JOIN gate_passes g ON g."packingListId" = p.id
      WHERE p."companyId" = :companyId${cu.replace('gl."customerId"', 'sc."customerId"')} GROUP BY p.id, sc.id, cu.id, g.id`, rep)) {
    const m = round(r.a + r.b + r.cp);
    ev.push({ date: ymd(r.date), order: 5, type: 'Packing list', party: r.party, customerId: r.customerId, soCardId: r.soCardId, soNo: r.cardNo, lotNo: r.lots, department: 'Packing', ref: `List# ${r.listNo}`,
      packedMeters: m, amount: round(r.a * r.rateA + r.b * r.rateB + r.cp * r.rateCP), detail: `${r.status === 'FINAL' ? 'Final' : 'Draft'}: A ${round(r.a)} / B ${round(r.b)} / CP ${round(r.cp)}${r.isGreyReturn ? ` | ${TAG}` : ''}` });
    if (r.gatePassNo) {
      ev.push({ date: ymd(r.passDate), order: 6, type: 'Gate pass', party: r.party, customerId: r.customerId, soCardId: r.soCardId, soNo: r.cardNo, lotNo: r.lots, department: 'Packing', ref: `Gate pass# ${r.gatePassNo}`,
        dispatchedMeters: m, detail: r.vehicleNo || '' });
    }
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
}

const num = (v) => v || 0;

/** Event ledger with the running grey-store balance. */
async function ledger(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'PACKING']);
  let ev = await events(req.user.companyId, f);
  let bal = 0;
  for (const e of ev) { bal = round(bal + num(e.greyIn) - num(e.greyOut)); e.balance = bal; }
  if (f.soNo) ev = ev.filter((e) => e.soNo === f.soNo);
  if (f.search) {
    const s = String(f.search).toLowerCase();
    ev = ev.filter((e) => [e.lotNo, e.soNo, e.ref, e.party, e.detail, e.department].some((v) => v !== undefined && String(v).toLowerCase().includes(s)));
  }
  const rows = [];
  if (f.dateFrom) {
    const before = ev.filter((e) => e.date < f.dateFrom);
    const open = before.length ? before[before.length - 1].balance : 0;
    rows.push({ date: f.dateFrom, type: 'Opening balance', balance: open });
    ev = ev.filter((e) => e.date >= f.dateFrom);
  }
  if (f.dateTo) ev = ev.filter((e) => e.date <= f.dateTo);
  const data = rows.concat(ev.map((e) => ({
    date: e.date, type: e.type, party: e.party, soNo: e.soNo ?? null, lotNo: e.lotNo ?? '', department: e.department || '', ref: e.ref, greyIn: round(num(e.greyIn)), greyOut: round(num(e.greyOut)), balance: e.balance,
    deptMeters: round(num(e.deptMeters)), packedMeters: round(num(e.packedMeters)), dispatchedMeters: round(num(e.dispatchedMeters)), amount: round(num(e.amount)), detail: e.detail || '',
  })));
  const columns = [col('date', 'Date', 'date'), col('type', 'Event'), col('party', 'Party'), col('soNo', 'SO#', 'number'), col('lotNo', 'Lot#s', 'list'), col('department', 'Department'), col('ref', 'Reference'),
    col('greyIn', 'Grey in (m)', 'number'), col('greyOut', 'Grey out (m)', 'number'), col('balance', 'Grey store balance (m)', 'number'), col('deptMeters', 'To department (m)', 'number'),
    col('packedMeters', 'Packed (m)', 'number'), col('dispatchedMeters', 'Dispatched (m)', 'number'), col('amount', 'Cost / amount', 'money'), col('detail', 'Detail')];
  return respond('Cloth ledger', f, [section('ledger', 'Ledger', columns, data, ['greyIn', 'greyOut', 'deptMeters', 'packedMeters', 'dispatchedMeters'])], f);
}

/** One row per day. */
async function dailyStock(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'PACKING']);
  const ev = await events(req.user.companyId, f);
  const days = new Map();
  let bal = 0;
  const get = (d) => days.get(d) || days.set(d, { date: d, greyIn: 0, greyOut: 0, deptMeters: 0, packedMeters: 0, dispatchedMeters: 0, closing: 0 }).get(d);
  for (const e of ev) {
    const d = get(e.date);
    d.greyIn += num(e.greyIn); d.greyOut += num(e.greyOut); d.deptMeters += num(e.deptMeters); d.packedMeters += num(e.packedMeters); d.dispatchedMeters += num(e.dispatchedMeters);
  }
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) { d.opening = round(bal); bal += d.greyIn - d.greyOut; d.closing = round(bal); }
  let rows = sorted.filter((d) => (!f.dateFrom || d.date >= f.dateFrom) && (!f.dateTo || d.date <= f.dateTo)).reverse();
  rows = rows.map((d) => ({ ...d, greyIn: round(d.greyIn), greyOut: round(d.greyOut), deptMeters: round(d.deptMeters), packedMeters: round(d.packedMeters), dispatchedMeters: round(d.dispatchedMeters) }));
  const columns = [col('date', 'Date', 'date'), col('opening', 'Grey store opening (m)', 'number'), col('greyIn', 'Grey in (m)', 'number'), col('greyOut', 'Grey out (m)', 'number'), col('closing', 'Grey store closing (m)', 'number'),
    col('deptMeters', 'Sent to departments (m)', 'number'), col('packedMeters', 'Packed (m)', 'number'), col('dispatchedMeters', 'Dispatched (m)', 'number')];
  return respond('Day to day stock', f, [section('daily', 'Day to day', columns, rows, ['greyIn', 'greyOut', 'deptMeters', 'packedMeters', 'dispatchedMeters'])], f);
}

module.exports = { ledger, dailyStock };
