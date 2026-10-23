// Audit ledgers (2026-10-23). Every ledger is dated rows with a running balance, oldest first, plus an opening balance
// row when dateFrom is given. Same answer shape as reportService (`sections`), `all=true` for PDF / Excel.
//   lotLedger          one grey lot: came, given back, taken on SO cards, with jobs / packing / gate pass shown for information
//   soCardLedger       one SO card (or all): cloth taken, every department job with cost, packing lists, gate passes; meters still in the mill
//   departmentLedger   one department: meters in (jobs received) and out (sent on) with the running meters inside
//   operatorLedger     one operator: every job handled with meters, thaans, chemical cost; running meters
//   costLedger         chemical cost lines by SO card with a running total
//   partyLedger        one party: cloth and money (packed value, chemical cost) with running balances
//   auditCheck         reconciliation of lots and SO cards: every difference is shown as CHECK
const { _x } = require('./reportService');

const { q, round, col, section, respond, chemLines, needAnyService, myDepartments, jobCards } = _x;
const nz = (v) => v || 0;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const TAG = 'Fabric return grey (not processed)';

/** Adds a running balance per group; adds an opening row per group when dateFrom is given; cuts to dateFrom..dateTo. */
function runLedger(rows, f, { group = () => 'all', delta, label = () => ({}) }) {
  const sorted = rows.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0));
  const bal = new Map();
  const out = [];
  const opened = new Set();
  for (const r of sorted) {
    const g = group(r);
    const before = bal.get(g) || 0;
    if (f.dateFrom && r.date >= f.dateFrom && !opened.has(g)) { opened.add(g); out.push({ date: f.dateFrom, type: 'Opening balance', ...label(r), balance: round(before) }); }
    const now = round(before + delta(r));
    bal.set(g, now);
    if ((!f.dateFrom || r.date >= f.dateFrom) && (!f.dateTo || r.date <= f.dateTo)) out.push({ ...r, balance: now });
  }
  return out;
}

async function lotLedger(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD']);
  const cid = req.user.companyId;
  const where = ['gl."companyId" = :cid', 'gl."deletedAt" IS NULL', 'gl."isApproved"'];
  const rep = { cid };
  if (f.customerId) { where.push('gl."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.qualityId) { where.push('gl."qualityId" = :qualityId'); rep.qualityId = f.qualityId; }
  if (f.search) { where.push('(gl."lotNo"::text = :search OR gl."dcNo" ILIKE :like OR gl."typeNo"::text = :search)'); rep.search = f.search; rep.like = `%${f.search}%`; }
  const lots = await q(`SELECT gl.id, gl."lotNo", gl."dcNo", gl."inwardDate", gl."inwardMeters"::float AS meters, cu.name AS party FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" WHERE ${where.join(' AND ')}`, rep);
  if (!lots.length) return respond('Lot ledger', f, [section('lot', 'Lot ledger', [], [])], f);
  const ids = lots.map((l) => l.id);
  const rows = lots.map((l) => ({ date: ymd(l.inwardDate), order: 1, lotNo: l.lotNo, lotId: l.id, party: l.party, type: 'Grey in', ref: l.dcNo ? `DC# ${l.dcNo}` : '', inMeters: l.meters, outMeters: 0, detail: 'Grey received' }));
  const info = (r) => rows.push(r);
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  for (const r of await q('SELECT r."lotId", r."returnDate" AS date, r."returnNo", r.meters::float AS meters, r."vehicleNo" FROM grey_returns r WHERE r."lotId" IN (:ids)', { ids })) {
    const l = lotOf.get(r.lotId); info({ date: ymd(r.date), order: 2, lotNo: l.lotNo, lotId: l.id, party: l.party, type: 'Grey given back', ref: `Return# ${r.returnNo}`, inMeters: 0, outMeters: r.meters, detail: r.vehicleNo || '' });
  }
  for (const r of await q(`SELECT scl."greyLotId" AS "lotId", sc."cardDate" AS date, sc."cardNo", sc."isGreyReturn", scl.meters::float AS meters FROM so_card_lots scl
      JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" IN (:ids)`, { ids })) {
    const l = lotOf.get(r.lotId); info({ date: ymd(r.date), order: 3, lotNo: l.lotNo, lotId: l.id, party: l.party, type: r.isGreyReturn ? 'Fabric return' : 'SO card', ref: r.isGreyReturn ? `FR-${r.cardNo}` : `SO# ${r.cardNo}`,
      inMeters: 0, outMeters: r.meters, detail: r.isGreyReturn ? TAG : 'Taken from grey store' });
  }
  const mill = [];
  for (const r of await q(`SELECT scl."greyLotId" AS "lotId", j."jobDate" AS date, j."jobNo", s.name AS department, sc."cardNo", SUM(ji.meters)::float AS meters
      FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' JOIN services s ON s.id = j."departmentId" JOIN so_card_lots scl ON scl.id = ji."soCardLotId" JOIN so_cards sc ON sc.id = ji."soCardId"
      WHERE scl."greyLotId" IN (:ids) GROUP BY scl."greyLotId", j.id, s.name, sc.id`, { ids })) {
    const l = lotOf.get(r.lotId); mill.push({ date: ymd(r.date), order: 4, lotNo: l.lotNo, lotId: l.id, party: l.party, type: 'Department', ref: `Job# ${r.jobNo} (SO# ${r.cardNo})`, department: r.department, millMeters: r.meters, detail: 'Information, not in balance' });
  }
  for (const r of await q(`SELECT l."greyLotId" AS "lotId", p."listDate" AS date, p."listNo", sc."cardNo", l.grade, SUM(l.meters)::float AS meters, g."gatePassNo", g."passDate"
      FROM packing_list_lines l JOIN packing_lists p ON p.id = l."packingListId" JOIN so_cards sc ON sc.id = p."soCardId" LEFT JOIN gate_passes g ON g."packingListId" = p.id
      WHERE l."greyLotId" IN (:ids) GROUP BY l."greyLotId", p.id, sc.id, l.grade, g.id`, { ids })) {
    const l = lotOf.get(r.lotId);
    mill.push({ date: ymd(r.date), order: 5, lotNo: l.lotNo, lotId: l.id, party: l.party, type: 'Packing list', ref: `List# ${r.listNo} (SO# ${r.cardNo})`, department: 'Packing', millMeters: r.meters, detail: `Grade ${r.grade}${r.gatePassNo ? ` | Gate pass# ${r.gatePassNo} on ${ymd(r.passDate)}` : ''}` });
  }
  const ledger = runLedger(rows, f, { group: (r) => r.lotId, delta: (r) => r.inMeters - r.outMeters, label: (r) => ({ lotNo: r.lotNo, party: r.party }) });
  const info2 = mill.filter((r) => (!f.dateFrom || r.date >= f.dateFrom) && (!f.dateTo || r.date <= f.dateTo));
  const lastBal = new Map();
  const merged = ledger.concat(info2).sort((a, b) => a.lotNo - b.lotNo || a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0));
  for (const r of merged) { if (r.balance === undefined) r.balance = lastBal.get(r.lotNo) ?? 0; else lastBal.set(r.lotNo, r.balance); }
  const data = merged.map((r) => ({ date: r.date, lotNo: r.lotNo, party: r.party, type: r.type, ref: r.ref || '', department: r.department || '', inMeters: round(nz(r.inMeters)), outMeters: round(nz(r.outMeters)), balance: r.balance, millMeters: round(nz(r.millMeters)), detail: r.detail || '' }));
  const columns = [col('date', 'Date', 'date'), col('lotNo', 'Lot#', 'number'), col('party', 'Party'), col('type', 'Event'), col('ref', 'Reference'), col('department', 'Department'),
    col('inMeters', 'In (m)', 'number'), col('outMeters', 'Out (m)', 'number'), col('balance', 'Grey store balance (m)', 'number'), col('millMeters', 'Meters (info)', 'number'), col('detail', 'Detail')];
  return respond('Lot ledger', f, [section('lot', 'Lot ledger', columns, data, ['inMeters', 'outMeters'])], f);
}

async function soCardLedger(req, f) {
  await needAnyService(req, ['SO_CARD', 'PACKING']);
  const cid = req.user.companyId;
  const where = ['sc."companyId" = :cid', 'sc."deletedAt" IS NULL'];
  const rep = { cid };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); rep.soNo = f.soNo; }
  if (f.isGreyReturn !== undefined) { where.push('sc."isGreyReturn" = :gr'); rep.gr = f.isGreyReturn; }
  const cards = await q(`SELECT sc.id, sc."cardNo", CASE WHEN sc."isGreyReturn" THEN 'FR-' || sc."cardNo" ELSE sc."cardNo"::text END AS label, sc."cardDate", sc."isGreyReturn", cu.name AS party FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" WHERE ${where.join(' AND ')}`, rep);
  if (!cards.length) return respond('SO card ledger', f, [section('card', 'SO card ledger', [], [])], f);
  const ids = cards.map((c) => c.id);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const cost = new Map();
  for (const l of await chemLines(cid, {})) cost.set(`${l.jobId}:${l.soCardId}`, (cost.get(`${l.jobId}:${l.soCardId}`) || 0) + l.amount);
  const rows = [];
  const add = (c, r) => rows.push({ soNo: c.label, sortNo: (c.isGreyReturn ? 1e9 : 0) + c.cardNo, soCardId: c.id, party: c.party, department: '', ref: '', taken: 0, dept: 0, packed: 0, dispatched: 0, amount: 0, detail: c.isGreyReturn ? TAG : '', ...r });
  for (const r of await q(`SELECT scl."soCardId", gl."lotNo", scl.meters::float AS meters, sc."cardDate" AS date FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" JOIN grey_lots gl ON gl.id = scl."greyLotId" WHERE scl."soCardId" IN (:ids)`, { ids })) {
    add(byId.get(r.soCardId), { date: ymd(r.date), order: 1, type: 'Cloth taken', ref: `Lot# ${r.lotNo}`, taken: r.meters });
  }
  for (const r of await q(`SELECT ji."soCardId", ji."jobId", j."jobDate" AS date, j."jobNo", j.status, j."operatorName", s.name AS department, SUM(ji.meters)::float AS meters FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED'
      JOIN services s ON s.id = j."departmentId" WHERE ji."soCardId" IN (:ids) GROUP BY ji."soCardId", ji."jobId", j.id, s.name`, { ids })) {
    add(byId.get(r.soCardId), { date: ymd(r.date), order: 2, type: 'Department', department: r.department, ref: `Job# ${r.jobNo}`, dept: r.meters, amount: round(cost.get(`${r.jobId}:${r.soCardId}`) || 0), detail: [r.operatorName ? `Operator ${r.operatorName}` : '', byId.get(r.soCardId).isGreyReturn ? TAG : ''].filter(Boolean).join(' | ') });
  }
  for (const r of await q(`SELECT p."soCardId", p."listDate" AS date, p."listNo", p.status, g."gatePassNo", g."passDate", g."vehicleNo",
      COALESCE(SUM(l.meters), 0)::float AS meters, COALESCE(SUM(l.meters * (CASE l.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END)), 0)::float AS value
      FROM packing_lists p LEFT JOIN packing_list_lines l ON l."packingListId" = p.id LEFT JOIN gate_passes g ON g."packingListId" = p.id WHERE p."soCardId" IN (:ids) GROUP BY p.id, g.id`, { ids })) {
    add(byId.get(r.soCardId), { date: ymd(r.date), order: 3, type: 'Packing list', department: 'Packing', ref: `List# ${r.listNo}`, packed: r.meters, amount: round(r.value), detail: r.status === 'FINAL' ? 'Final' : 'Draft' });
    if (r.gatePassNo) add(byId.get(r.soCardId), { date: ymd(r.passDate), order: 4, type: 'Gate pass', department: 'Packing', ref: `Gate pass# ${r.gatePassNo}`, dispatched: r.meters, detail: r.vehicleNo || '' });
  }
  // meters still in the mill = cloth taken - dispatched
  const ledger = runLedger(rows, f, { group: (r) => r.soCardId, delta: (r) => r.taken - r.dispatched, label: (r) => ({ soNo: r.soNo, sortNo: r.sortNo, party: r.party }) })
    .sort((a, b) => a.sortNo - b.sortNo || a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0));
  const data = ledger.map((r) => ({ date: r.date, soNo: r.soNo, party: r.party, type: r.type, department: r.department || '', ref: r.ref || '', taken: round(nz(r.taken)), dept: round(nz(r.dept)), packed: round(nz(r.packed)),
    dispatched: round(nz(r.dispatched)), balance: r.balance, amount: round(nz(r.amount)), detail: r.detail || '' }));
  const columns = [col('date', 'Date', 'date'), col('soNo', 'SO#'), col('party', 'Party'), col('type', 'Event'), col('department', 'Department'), col('ref', 'Reference'), col('taken', 'Cloth taken (m)', 'number'),
    col('dept', 'To department (m)', 'number'), col('packed', 'Packed (m)', 'number'), col('dispatched', 'Dispatched (m)', 'number'), col('balance', 'Meters in mill (m)', 'number'), col('amount', 'Cost / packed value', 'money'), col('detail', 'Detail')];
  return respond('SO card ledger', f, [section('card', 'SO card ledger', columns, data, ['taken', 'dispatched', 'amount'])], f);
}

async function departmentLedger(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const cid = req.user.companyId;
  const deps = await myDepartments(req);
  const ids = (f.departmentId ? deps.filter((d) => d.id === f.departmentId) : deps).map((d) => d.id);
  if (!ids.length) return respond('Department ledger', f, [section('dept', 'Department ledger', [], [])], f);
  const cond = (f.customerId ? ' AND sc."customerId" = :customerId' : '') + (f.soNo ? ' AND sc."cardNo" = :soNo' : '');
  const rep = { ids, customerId: f.customerId, soNo: f.soNo };
  const rows = [];
  for (const r of await q(`SELECT j."departmentId", s.name AS department, j."jobDate" AS date, j."jobNo", CASE WHEN sc."isGreyReturn" THEN 'FR-' || sc."cardNo" ELSE sc."cardNo"::text END AS "cardNo", cu.name AS party, fs.name AS "fromDepartment", SUM(ji.meters)::float AS meters
      FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' JOIN services s ON s.id = j."departmentId" LEFT JOIN services fs ON fs.id = j."fromDepartmentId"
      JOIN so_cards sc ON sc.id = ji."soCardId" JOIN customers cu ON cu.id = sc."customerId" WHERE j."departmentId" IN (:ids)${cond} GROUP BY j.id, s.name, fs.name, sc.id, cu.id`, rep)) {
    rows.push({ date: ymd(r.date), order: 1, departmentId: r.departmentId, department: r.department, soNo: r.cardNo, party: r.party, type: 'Received', ref: `Job# ${r.jobNo}`, inMeters: r.meters, outMeters: 0, detail: `From ${r.fromDepartment || 'SO card'}` });
  }
  for (const r of await q(`SELECT pj."departmentId", ps.name AS department, cj."jobDate" AS date, cj."jobNo", cs.name AS "toDepartment", CASE WHEN sc."isGreyReturn" THEN 'FR-' || sc."cardNo" ELSE sc."cardNo"::text END AS "cardNo", cu.name AS party, SUM(ci.meters)::float AS meters
      FROM job_items ci JOIN jobs cj ON cj.id = ci."jobId" AND cj.status <> 'REJECTED' JOIN job_items pi ON pi.id = ci."sourceJobItemId" JOIN jobs pj ON pj.id = pi."jobId" AND pj.status <> 'REJECTED'
      JOIN services ps ON ps.id = pj."departmentId" JOIN services cs ON cs.id = cj."departmentId" JOIN so_cards sc ON sc.id = ci."soCardId" JOIN customers cu ON cu.id = sc."customerId"
      WHERE pj."departmentId" IN (:ids)${cond} GROUP BY pj."departmentId", ps.name, cj.id, cs.name, sc.id, cu.id`, rep)) {
    rows.push({ date: ymd(r.date), order: 2, departmentId: r.departmentId, department: r.department, soNo: r.cardNo, party: r.party, type: 'Sent on', ref: `Job# ${r.jobNo}`, inMeters: 0, outMeters: r.meters, detail: `To ${r.toDepartment}` });
  }
  const ledger = runLedger(rows, f, { group: (r) => r.departmentId, delta: (r) => r.inMeters - r.outMeters, label: (r) => ({ department: r.department }) })
    .sort((a, b) => a.department.localeCompare(b.department) || a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0));
  const data = ledger.map((r) => ({ date: r.date, department: r.department, type: r.type, ref: r.ref || '', soNo: r.soNo ?? null, party: r.party || '', inMeters: round(nz(r.inMeters)), outMeters: round(nz(r.outMeters)), balance: r.balance, detail: r.detail || '' }));
  const columns = [col('date', 'Date', 'date'), col('department', 'Department'), col('type', 'Event'), col('ref', 'Reference'), col('soNo', 'SO#'), col('party', 'Party'),
    col('inMeters', 'In (m)', 'number'), col('outMeters', 'Out (m)', 'number'), col('balance', 'Inside department (m)', 'number'), col('detail', 'Detail')];
  return respond('Department ledger', f, [section('dept', 'Department ledger', columns, data, ['inMeters', 'outMeters'])], f);
}

async function operatorLedger(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const deps = await myDepartments(req, ['PROCESS', 'FOLDING']);
  const ids = f.departmentId ? deps.filter((d) => d.id === f.departmentId).map((d) => d.id) : deps.map((d) => d.id);
  const jobs = (await jobCards(req.user.companyId, { ...f, status: undefined, departmentIds: ids })).filter((j) => j.operatorName && j.status !== 'REJECTED');
  const chem = await chemLines(req.user.companyId, {});
  const rows = jobs.map((j) => ({ date: ymd(j.processDate || j.jobDate), order: 1, operatorName: j.operatorName, department: j.department, type: 'Job', ref: `Job# ${j.jobNo}`, soNo: j.isGreyReturn ? `FR-${j.soNo}` : j.soNo, party: j.customer,
    thaans: j.thaans || 0, meters: j.meters, amount: chem.filter((l) => l.jobId === j.jobId && l.soCardId === j.soCardId).reduce((t, l) => t + l.amount, 0), detail: j.isGreyReturn ? TAG : '' }));
  const ledger = runLedger(rows, f, { group: (r) => r.operatorName, delta: (r) => r.meters, label: (r) => ({ operatorName: r.operatorName }) })
    .sort((a, b) => a.operatorName.localeCompare(b.operatorName) || a.date.localeCompare(b.date));
  const data = ledger.map((r) => ({ date: r.date, operatorName: r.operatorName, department: r.department || '', type: r.type, ref: r.ref || '', soNo: r.soNo ?? null, party: r.party || '', thaans: nz(r.thaans), meters: round(nz(r.meters)), balance: r.balance, amount: round(nz(r.amount)), detail: r.detail || '' }));
  const columns = [col('date', 'Date', 'date'), col('operatorName', 'Operator'), col('department', 'Department'), col('type', 'Event'), col('ref', 'Reference'), col('soNo', 'SO#'), col('party', 'Party'),
    col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('balance', 'Total meters so far', 'number'), col('amount', 'Chemical cost', 'money'), col('detail', 'Detail')];
  return respond('Operator ledger', f, [section('operator', 'Operator ledger', columns, data, ['thaans', 'meters', 'amount'])], f);
}

async function costLedger(req, f) {
  await needAnyService(req, ['CHEMICAL_STORE', 'SO_CARD']);
  const cid = req.user.companyId;
  const deps = await myDepartments(req, ['PROCESS', 'FOLDING']);
  const seeAll = req.user.userType === 'CLIENT_ADMIN' || (await _x.hasReportService(req));
  let lines = await chemLines(cid, f);
  if (!seeAll) lines = lines.filter((l) => deps.some((d) => d.id === l.departmentId));
  if (f.departmentId) lines = lines.filter((l) => l.departmentId === f.departmentId);
  if (f.itemId) lines = lines.filter((l) => l.itemId === f.itemId);
  if (f.jobNo) lines = lines.filter((l) => l.jobNo === f.jobNo);
  const cards = new Map((await q(`SELECT sc.id, sc."cardNo", CASE WHEN sc."isGreyReturn" THEN 'FR-' || sc."cardNo" ELSE sc."cardNo"::text END AS label, sc."customerId", cu.name AS party FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" WHERE sc."companyId" = :cid`, { cid })).map((c) => [c.id, c]));
  const rows = lines.filter((l) => cards.has(l.soCardId)).map((l) => { const c = cards.get(l.soCardId); return { date: ymd(l.sentAt), order: l.reqNo, soCardId: l.soCardId, soNo: c.label, sortNo: c.cardNo, customerId: c.customerId, party: c.party, department: l.department,
    ref: `Req# ${l.reqNo} / Job# ${l.jobNo}`, type: 'Chemical issued', chemical: l.chemical, unit: l.unit, qty: round(l.qty), amount: round(l.amount) }; })
    .filter((r) => (!f.customerId || r.customerId === f.customerId) && (!f.soNo || r.sortNo === f.soNo));
  const ledger = runLedger(rows, f, { group: (r) => r.soCardId, delta: (r) => r.amount, label: (r) => ({ soNo: r.soNo, sortNo: r.sortNo, party: r.party }) }).sort((a, b) => nz(a.sortNo) - nz(b.sortNo) || a.date.localeCompare(b.date));
  const data = ledger.map((r) => ({ date: r.date, soNo: r.soNo, party: r.party, department: r.department || '', type: r.type, ref: r.ref || '', chemical: r.chemical || '', unit: r.unit || '', qty: nz(r.qty), amount: nz(r.amount), balance: r.balance }));
  const columns = [col('date', 'Date', 'date'), col('soNo', 'SO#'), col('party', 'Party'), col('department', 'Department'), col('type', 'Event'), col('ref', 'Reference'), col('chemical', 'Chemical'),
    col('unit', 'Unit'), col('qty', 'Qty', 'number'), col('amount', 'Cost', 'money'), col('balance', 'Total cost so far', 'money')];
  return respond('Chemical cost ledger', f, [section('cost', 'Cost ledger', columns, data, ['amount'])], f);
}

async function partyLedger(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'PACKING']);
  const cid = req.user.companyId;
  const cu = f.customerId ? ' AND sc."customerId" = :customerId' : '';
  const rep = { cid, customerId: f.customerId };
  const rows = [];
  for (const r of await q(`SELECT gl."inwardDate" AS date, gl."lotNo", gl."dcNo", cust.name AS party, cust.id AS cid, gl."inwardMeters"::float AS meters FROM grey_lots gl JOIN customers cust ON cust.id = gl."customerId"
      WHERE gl."companyId" = :cid AND gl."deletedAt" IS NULL AND gl."isApproved"${cu.replace('sc."customerId"', 'gl."customerId"')}`, rep)) rows.push({ date: ymd(r.date), order: 1, cid: r.cid, party: r.party, type: 'Grey in', ref: `Lot# ${r.lotNo}${r.dcNo ? ` DC# ${r.dcNo}` : ''}`, greyIn: r.meters });
  for (const r of await q(`SELECT rt."returnDate" AS date, rt."returnNo", rt.meters::float AS meters, cust.name AS party, cust.id AS cid FROM grey_returns rt JOIN grey_lots gl ON gl.id = rt."lotId" JOIN customers cust ON cust.id = gl."customerId"
      WHERE rt."companyId" = :cid${cu.replace('sc."customerId"', 'gl."customerId"')}`, rep)) rows.push({ date: ymd(r.date), order: 2, cid: r.cid, party: r.party, type: 'Grey given back', ref: `Return# ${r.returnNo}`, greyOut: r.meters });
  for (const r of await q(`SELECT sc."cardDate" AS date, sc."cardNo", sc."isGreyReturn", cust.name AS party, cust.id AS cid, SUM(scl.meters)::float AS meters FROM so_cards sc JOIN customers cust ON cust.id = sc."customerId" JOIN so_card_lots scl ON scl."soCardId" = sc.id
      WHERE sc."companyId" = :cid AND sc."deletedAt" IS NULL${cu} GROUP BY sc.id, cust.id`, rep)) rows.push({ date: ymd(r.date), order: 3, cid: r.cid, party: r.party, type: r.isGreyReturn ? 'Fabric return' : 'SO card', ref: r.isGreyReturn ? `FR-${r.cardNo}` : `SO# ${r.cardNo}`, greyOut: r.meters });
  const cardCust = new Map((await q('SELECT sc.id, sc."customerId" FROM so_cards sc WHERE sc."companyId" = :cid', { cid })).map((c) => [c.id, c.customerId]));
  const cost = new Map();
  for (const l of await chemLines(cid, {})) { const c = cardCust.get(l.soCardId); cost.set(c, round(nz(cost.get(c)) + l.amount)); }
  for (const r of await q(`SELECT p."listDate" AS date, p."listNo", p.status, sc."cardNo", cust.name AS party, cust.id AS cid, g."gatePassNo", g."passDate",
      COALESCE(SUM(l.meters), 0)::float AS meters, COALESCE(SUM(l.meters * (CASE l.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END)), 0)::float AS value
      FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" JOIN customers cust ON cust.id = sc."customerId" LEFT JOIN packing_list_lines l ON l."packingListId" = p.id LEFT JOIN gate_passes g ON g."packingListId" = p.id
      WHERE p."companyId" = :cid${cu} GROUP BY p.id, sc.id, cust.id, g.id`, rep)) {
    rows.push({ date: ymd(r.date), order: 4, cid: r.cid, party: r.party, type: 'Packing list', ref: `List# ${r.listNo} (SO# ${r.cardNo})`, packed: r.meters, value: round(r.value), detail: r.status === 'FINAL' ? 'Final' : 'Draft' });
    if (r.gatePassNo) rows.push({ date: ymd(r.passDate), order: 5, cid: r.cid, party: r.party, type: 'Gate pass', ref: `Gate pass# ${r.gatePassNo}`, dispatched: r.meters });
  }
  const ledger = runLedger(rows, f, { group: (r) => r.cid, delta: (r) => nz(r.greyIn) - nz(r.greyOut), label: (r) => ({ party: r.party }) }).sort((a, b) => a.party.localeCompare(b.party) || a.date.localeCompare(b.date) || (a.order || 0) - (b.order || 0));
  const valueBal = new Map();
  const data = ledger.map((r) => {
    if (r.value) valueBal.set(r.party, round(nz(valueBal.get(r.party)) + r.value));
    return { date: r.date, party: r.party, type: r.type, ref: r.ref || '', greyIn: round(nz(r.greyIn)), greyOut: round(nz(r.greyOut)), balance: r.balance, packed: round(nz(r.packed)), dispatched: round(nz(r.dispatched)),
      value: round(nz(r.value)), valueTotal: nz(valueBal.get(r.party)), detail: r.detail || '' };
  });
  const columns = [col('date', 'Date', 'date'), col('party', 'Party'), col('type', 'Event'), col('ref', 'Reference'), col('greyIn', 'Grey in (m)', 'number'), col('greyOut', 'Grey out (m)', 'number'),
    col('balance', 'Grey store balance (m)', 'number'), col('packed', 'Packed (m)', 'number'), col('dispatched', 'Dispatched (m)', 'number'), col('value', 'Packed value', 'money'), col('valueTotal', 'Packed value so far', 'money'), col('detail', 'Detail')];
  return respond('Party ledger', f, [section('party', 'Party ledger', columns, data, ['greyIn', 'greyOut', 'packed', 'dispatched', 'value'])], f);
}

/** Reconciliation: every difference is a row marked CHECK. Nothing is changed. */
async function auditCheck(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'PACKING']);
  const cid = req.user.companyId;
  const lots = await q(`SELECT gl."lotNo", cu.name AS party, gl."inwardMeters"::float AS inward, gl."outwardMeters"::float AS outward, gl."returnedMeters"::float AS back,
      COALESCE((SELECT SUM(scl.meters) FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" AND sc."deletedAt" IS NULL WHERE scl."greyLotId" = gl.id), 0)::float AS "onCards",
      COALESCE((SELECT SUM(rt.meters) FROM grey_returns rt WHERE rt."lotId" = gl.id), 0)::float AS "returned"
    FROM grey_lots gl JOIN customers cu ON cu.id = gl."customerId" WHERE gl."companyId" = :cid AND gl."deletedAt" IS NULL AND gl."isApproved"${f.customerId ? ' AND gl."customerId" = :customerId' : ''} ORDER BY gl."lotNo"`, { cid, customerId: f.customerId });
  const lotRows = lots.map((l) => {
    const expected = round(l.onCards + l.returned);
    const diff = round(l.outward - expected);
    return { what: 'Grey lot', ref: `Lot# ${l.lotNo}`, party: l.party, a: round(l.inward), b: round(l.outward), expected, difference: diff, status: Math.abs(diff) > 0.01 || l.outward - l.inward > 0.01 ? 'CHECK' : 'OK',
      note: 'Came / outward in store / SO cards + given back' };
  });
  const cards = await q(`SELECT sc."cardNo", sc."isGreyReturn", cu.name AS party, sc."totalMeters"::float AS total,
      COALESCE((SELECT SUM(scl.meters) FROM so_card_lots scl WHERE scl."soCardId" = sc.id), 0)::float AS lots,
      COALESCE((SELECT SUM(ji.meters) FROM job_items ji JOIN jobs j ON j.id = ji."jobId" AND j.status <> 'REJECTED' WHERE ji."soCardId" = sc.id AND ji."sourceJobItemId" IS NULL), 0)::float AS sent,
      COALESCE((SELECT SUM(l.meters) FROM packing_lists p JOIN packing_list_lines l ON l."packingListId" = p.id WHERE p."soCardId" = sc.id), 0)::float AS packed,
      COALESCE((SELECT SUM(l.meters) FROM packing_lists p JOIN packing_list_lines l ON l."packingListId" = p.id JOIN gate_passes g ON g."packingListId" = p.id WHERE p."soCardId" = sc.id), 0)::float AS dispatched
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" WHERE sc."companyId" = :cid AND sc."deletedAt" IS NULL${f.customerId ? ' AND sc."customerId" = :customerId' : ''} ORDER BY sc."cardNo"`, { cid, customerId: f.customerId });
  const cardRows = [];
  for (const c of cards) {
    const label = c.isGreyReturn ? `FR-${c.cardNo}` : `SO# ${c.cardNo}`;
    const d1 = round(c.total - c.lots);
    cardRows.push({ what: 'SO card total', ref: label, party: c.party, a: round(c.total), b: round(c.lots), expected: round(c.lots), difference: d1, status: Math.abs(d1) > 0.01 ? 'CHECK' : 'OK', note: 'Card total / sum of its lots' });
    cardRows.push({ what: 'Sent to departments', ref: label, party: c.party, a: round(c.total), b: round(c.sent), expected: round(c.total), difference: round(c.sent - c.total), status: c.sent - c.total > 0.01 ? 'CHECK' : 'OK', note: 'Card total / first jobs (can never be more than the card)' });
    cardRows.push({ what: 'Packed and dispatched', ref: label, party: c.party, a: round(c.packed), b: round(c.dispatched), expected: round(c.packed), difference: round(c.dispatched - c.packed), status: c.dispatched - c.packed > 0.01 || c.packed - c.total > 0.01 ? 'CHECK' : 'OK', note: 'Packed / dispatched (dispatched cannot be more than packed; packed cannot be more than the card)' });
  }
  let rows = lotRows.concat(cardRows);
  if (f.status === 'check') rows = rows.filter((r) => r.status === 'CHECK');
  const columns = [col('what', 'Check'), col('ref', 'Reference'), col('party', 'Party'), col('a', 'Value 1 (m)', 'number'), col('b', 'Value 2 (m)', 'number'), col('expected', 'Expected (m)', 'number'),
    col('difference', 'Difference (m)', 'number'), col('status', 'Result', 'tag'), col('note', 'What is compared')];
  const out = respond('Audit check (reconciliation)', f, [section('check', 'Reconciliation', columns, rows, ['difference'])], f);
  out.summary = { checked: lotRows.length + cardRows.length, ok: (lotRows.concat(cardRows)).filter((r) => r.status === 'OK').length, check: (lotRows.concat(cardRows)).filter((r) => r.status === 'CHECK').length };
  return out;
}

module.exports = { lotLedger, soCardLedger, departmentLedger, operatorLedger, costLedger, partyLedger, auditCheck };
