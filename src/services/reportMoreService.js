// More reports (2026-10-23), every angle of the mill. Same answer shape as reportService.
//   qualityWise      per quality: lots, grey, SO card meters, packed A / B / CP, packed value, chemical cost
//   partyCost        per party: meters, chemical cost, cost per metre, packed meters and value
//   gradeSummary     packed meters by grade (A / B / CP) per party or per quality
//   ageing           cloth still inside the mill by age bucket since grey arrival
//   pendingJobs      jobs not complete, with the days they have been waiting
//   deliveryDue      SO cards with a delivery date: packed so far, days left or late
//   reworkJobs       re-work and rejected jobs with the reason
//   departmentDaily  per department and day: jobs, SO cards, meters, chemical cost
const { _x } = require('./reportService');

const { q, round, col, section, respond, clothNow, chemLines, needAnyService, myDepartments, jobCards, costMap, STATUS_TEXT, cardPositions } = _x;
const nz = (v) => v || 0;
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Packed meters and value per SO card (all lists). */
async function packedBySoCard(companyId) {
  return q(`SELECT p."soCardId", sc."customerId", COALESCE(sc."qualityId", (SELECT gl."qualityId" FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE l."soCardId" = sc.id LIMIT 1)) AS "qualityId",
      COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'A'), 0)::float AS a, COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'B'), 0)::float AS b, COALESCE(SUM(l.meters) FILTER (WHERE l.grade = 'CP'), 0)::float AS cp,
      COALESCE(SUM(l.meters * (CASE l.grade WHEN 'A' THEN p."rateA" WHEN 'B' THEN p."rateB" ELSE p."rateCP" END)), 0)::float AS value
    FROM packing_lists p JOIN so_cards sc ON sc.id = p."soCardId" AND sc."deletedAt" IS NULL JOIN packing_list_lines l ON l."packingListId" = p.id
    WHERE p."companyId" = :companyId GROUP BY p."soCardId", sc.id`, { companyId });
}
async function cardRows(companyId, f) {
  const where = ['sc."companyId" = :companyId', 'sc."deletedAt" IS NULL'];
  const rep = { companyId };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.dateFrom) { where.push('sc."cardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('sc."cardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  return q(`SELECT sc.id, sc."cardNo", sc."cardDate", sc."deliveryDate", sc.status, sc."isGreyReturn", sc."customerId", cu.name AS party,
      COALESCE(sc."qualityId", (SELECT gl."qualityId" FROM so_card_lots l JOIN grey_lots gl ON gl.id = l."greyLotId" WHERE l."soCardId" = sc.id LIMIT 1)) AS "qualityId", sc."totalMeters"::float AS meters
    FROM so_cards sc JOIN customers cu ON cu.id = sc."customerId" WHERE ${where.join(' AND ')}`, rep);
}

async function qualityWise(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'PACKING']);
  const cid = req.user.companyId;
  const qualities = new Map((await q('SELECT id, name FROM qualities WHERE "companyId" = :cid AND "deletedAt" IS NULL', { cid })).map((x) => [x.id, x.name]));
  const lots = await q(`SELECT gl."qualityId", count(*)::int AS lots, SUM(gl."inwardMeters")::float AS grey FROM grey_lots gl
    WHERE gl."companyId" = :cid AND gl."deletedAt" IS NULL AND gl."isApproved" AND (:from::date IS NULL OR gl."inwardDate" >= :from::date) AND (:to::date IS NULL OR gl."inwardDate" <= :to::date) GROUP BY gl."qualityId"`,
  { cid, from: f.dateFrom || null, to: f.dateTo || null });
  const cards = await cardRows(cid, f);
  const packed = new Map((await packedBySoCard(cid)).map((p) => [p.soCardId, p]));
  const cost = costMap(await chemLines(cid), (l) => l.soCardId);
  const m = new Map();
  const get = (id) => m.get(id) || m.set(id, { quality: qualities.get(id) || '(no quality)', lots: 0, grey: 0, soCards: 0, soMeters: 0, a: 0, b: 0, cp: 0, value: 0, cost: 0 }).get(id);
  for (const l of lots) { const r = get(l.qualityId); r.lots += l.lots; r.grey += l.grey; }
  for (const c of cards) {
    const r = get(c.qualityId); const p = packed.get(c.id) || {};
    r.soCards += 1; r.soMeters += c.meters; r.a += nz(p.a); r.b += nz(p.b); r.cp += nz(p.cp); r.value += nz(p.value); r.cost += nz(cost.get(c.id));
  }
  let rows = [...m.entries()].filter(([id]) => !f.qualityId || id === f.qualityId).map(([, r]) => ({ ...r, grey: round(r.grey), soMeters: round(r.soMeters), a: round(r.a), b: round(r.b), cp: round(r.cp), value: round(r.value), cost: round(r.cost) }));
  rows.sort((x, y) => x.quality.localeCompare(y.quality));
  const columns = [col('quality', 'Quality'), col('lots', 'Lots', 'number'), col('grey', 'Grey in (m)', 'number'), col('soCards', 'SO cards', 'number'), col('soMeters', 'SO card (m)', 'number'),
    col('a', 'Packed A (m)', 'number'), col('b', 'Packed B (m)', 'number'), col('cp', 'Packed CP (m)', 'number'), col('value', 'Packed value', 'money'), col('cost', 'Chemical cost', 'money')];
  return respond('Quality wise', f, [section('quality', 'Quality wise', columns, rows, ['lots', 'grey', 'soCards', 'soMeters', 'a', 'b', 'cp', 'value', 'cost'])], f);
}

async function partyCost(req, f) {
  await needAnyService(req, ['SO_CARD', 'PACKING', 'CHEMICAL_STORE']);
  const cid = req.user.companyId;
  const cards = (await cardRows(cid, f)).filter((c) => !f.qualityId || c.qualityId === f.qualityId);
  const packed = new Map((await packedBySoCard(cid)).map((p) => [p.soCardId, p]));
  const cost = costMap(await chemLines(cid), (l) => l.soCardId);
  const m = new Map();
  for (const c of cards) {
    const r = m.get(c.customerId) || m.set(c.customerId, { party: c.party, soCards: 0, meters: 0, cost: 0, packedMeters: 0, value: 0 }).get(c.customerId);
    const p = packed.get(c.id) || {};
    r.soCards += 1; r.meters += c.meters; r.cost += nz(cost.get(c.id)); r.packedMeters += nz(p.a) + nz(p.b) + nz(p.cp); r.value += nz(p.value);
  }
  const rows = [...m.values()].map((r) => ({ ...r, meters: round(r.meters), cost: round(r.cost), costPerMeter: r.meters ? round(r.cost / r.meters) : 0, packedMeters: round(r.packedMeters), value: round(r.value) }))
    .sort((a, b) => a.party.localeCompare(b.party));
  const columns = [col('party', 'Party'), col('soCards', 'SO cards', 'number'), col('meters', 'SO card (m)', 'number'), col('cost', 'Chemical cost', 'money'), col('costPerMeter', 'Cost / m', 'money'),
    col('packedMeters', 'Packed (m)', 'number'), col('value', 'Packed value', 'money')];
  return respond('Party wise cost', f, [section('parties', 'Party wise cost', columns, rows, ['soCards', 'meters', 'cost', 'packedMeters', 'value'])], f);
}

async function gradeSummary(req, f) {
  await needAnyService(req, ['PACKING']);
  const cid = req.user.companyId;
  const byQuality = f.by === 'quality';
  const names = new Map((await q(byQuality ? 'SELECT id, name FROM qualities WHERE "companyId" = :cid' : 'SELECT id, name FROM customers WHERE "companyId" = :cid', { cid })).map((x) => [x.id, x.name]));
  const cards = new Map((await cardRows(cid, {})).map((c) => [c.id, c]));
  const m = new Map();
  for (const p of await packedBySoCard(cid)) {
    const c = cards.get(p.soCardId);
    if (!c || (f.customerId && c.customerId !== f.customerId) || (f.qualityId && c.qualityId !== f.qualityId)) continue;
    const key = byQuality ? c.qualityId : c.customerId;
    const r = m.get(key) || m.set(key, { name: names.get(key) || '(none)', a: 0, b: 0, cp: 0, value: 0 }).get(key);
    r.a += p.a; r.b += p.b; r.cp += p.cp; r.value += p.value;
  }
  const rows = [...m.values()].map((r) => {
    const tot = r.a + r.b + r.cp;
    return { name: r.name, a: round(r.a), b: round(r.b), cp: round(r.cp), total: round(tot), aPercent: tot ? round((r.a / tot) * 100) : 0, value: round(r.value) };
  }).sort((x, y) => x.name.localeCompare(y.name));
  const columns = [col('name', byQuality ? 'Quality' : 'Party'), col('a', 'A (m)', 'number'), col('b', 'B (m)', 'number'), col('cp', 'Cut piece (m)', 'number'), col('total', 'Total (m)', 'number'), col('aPercent', 'A %', 'number'), col('value', 'Value', 'money')];
  return respond(`Grade summary by ${byQuality ? 'quality' : 'party'}`, f, [section('grades', 'Grades', columns, rows, ['a', 'b', 'cp', 'total', 'value'])], f);
}

async function ageing(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'FOLDING']);
  const now = (await clothNow(req.user.companyId)).filter((n) => !f.customerId || n.customerId === f.customerId);
  const t = today();
  const m = new Map();
  for (const n of now) {
    const age = Math.max(0, daysBetween(ymd(n.inwardDate), t));
    const b = age <= 7 ? 'd7' : age <= 15 ? 'd15' : age <= 30 ? 'd30' : 'd30p';
    const r = m.get(n.customerId) || m.set(n.customerId, { party: n.customerName, d7: 0, d15: 0, d30: 0, d30p: 0, total: 0 }).get(n.customerId);
    r[b] += n.meters; r.total += n.meters;
  }
  const rows = [...m.values()].map((r) => ({ party: r.party, d7: round(r.d7), d15: round(r.d15), d30: round(r.d30), d30p: round(r.d30p), total: round(r.total) })).sort((a, b) => a.party.localeCompare(b.party));
  const columns = [col('party', 'Party'), col('d7', '0-7 days (m)', 'number'), col('d15', '8-15 days (m)', 'number'), col('d30', '16-30 days (m)', 'number'), col('d30p', 'Over 30 days (m)', 'number'), col('total', 'Total (m)', 'number')];
  return respond('Cloth ageing (days since grey arrived)', f, [section('ageing', 'Ageing', columns, rows, ['d7', 'd15', 'd30', 'd30p', 'total'])], f);
}

async function deptIds(req, f) {
  const deps = await myDepartments(req);
  return f.departmentId ? deps.filter((d) => d.id === f.departmentId).map((d) => d.id) : deps.map((d) => d.id);
}

async function pendingJobs(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const jobs = (await jobCards(req.user.companyId, { ...f, status: undefined, departmentIds: await deptIds(req, f) })).filter((j) => ['IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING'].includes(j.status) && (!f.status || j.status === f.status));
  const t = today();
  const rows = jobs.map((j) => ({ department: j.department, jobNo: j.jobNo, jobDate: j.jobDate, soNo: j.soNo, party: j.customer, statusText: STATUS_TEXT[j.status], operatorName: j.operatorName || '',
    thaans: nz(j.thaans), meters: round(j.meters), daysWaiting: Math.max(0, daysBetween(ymd(j.sentAt), t)) })).sort((a, b) => b.daysWaiting - a.daysWaiting);
  const columns = [col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('soNo', 'SO#', 'number'), col('party', 'Party'), col('statusText', 'Status'),
    col('operatorName', 'Operator'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('daysWaiting', 'Days since sent', 'number')];
  return respond('Pending jobs', f, [section('jobs', 'Jobs not complete', columns, rows, ['thaans', 'meters'])], f);
}

async function deliveryDue(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const cid = req.user.companyId;
  const cards = (await cardRows(cid, f)).filter((c) => c.deliveryDate && !c.isGreyReturn && (!f.qualityId || c.qualityId === f.qualityId));
  const packed = new Map((await packedBySoCard(cid)).map((p) => [p.soCardId, p]));
  const t = today();
  const pos = await cardPositions(cid);
  const rows = cards.map((c) => {
    const p = packed.get(c.id) || {}; const pm = nz(p.a) + nz(p.b) + nz(p.cp); const left = daysBetween(t, ymd(c.deliveryDate));
    return { soNo: c.cardNo, party: c.party, cardDate: c.cardDate, deliveryDate: c.deliveryDate, statusText: (pos.get(c.id) || { text: '' }).text, meters: round(c.meters), packedMeters: round(pm), balanceMeters: round(Math.max(0, c.meters - pm)),
      daysLeft: left, dueText: left < 0 ? `Late by ${-left} days` : left === 0 ? 'Due today' : `${left} days left` };
  }).filter((r) => f.stock !== 'open' || r.balanceMeters > 0).sort((a, b) => a.daysLeft - b.daysLeft);
  const columns = [col('soNo', 'SO#', 'number'), col('party', 'Party'), col('cardDate', 'Date', 'date'), col('deliveryDate', 'Delivery date', 'date'), col('statusText', 'Status'), col('meters', 'Meters', 'number'),
    col('packedMeters', 'Packed (m)', 'number'), col('balanceMeters', 'Balance (m)', 'number'), col('dueText', 'Delivery')];
  return respond('Delivery due', f, [section('due', 'SO cards with delivery date', columns, rows, ['meters', 'packedMeters', 'balanceMeters'])], f);
}

async function reworkJobs(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const jobs = (await jobCards(req.user.companyId, { ...f, status: undefined, departmentIds: await deptIds(req, f) })).filter((j) => j.isRework || j.status === 'REJECTED');
  const reasons = new Map((await q('SELECT id, "rejectReason" FROM jobs WHERE "companyId" = :cid AND "rejectReason" IS NOT NULL', { cid: req.user.companyId })).map((x) => [x.id, x.rejectReason]));
  const rows = jobs.map((j) => ({ department: j.department, jobNo: j.jobNo, jobDate: j.jobDate, soNo: j.soNo, party: j.customer, statusText: STATUS_TEXT[j.status], kind: j.status === 'REJECTED' ? 'Rejected' : 'Re-work',
    reason: reasons.get(j.jobId) || '', operatorName: j.operatorName || '', meters: round(j.meters) }));
  const columns = [col('kind', 'Type', 'tag'), col('department', 'Department'), col('jobNo', 'Job#', 'number'), col('jobDate', 'Date', 'date'), col('soNo', 'SO#', 'number'), col('party', 'Party'),
    col('statusText', 'Status'), col('reason', 'Reason'), col('operatorName', 'Operator'), col('meters', 'Meters', 'number')];
  return respond('Re-work and rejected jobs', f, [section('rework', 'Re-work and rejected', columns, rows, ['meters'])], f);
}

async function departmentDaily(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const jobs = (await jobCards(req.user.companyId, { ...f, departmentIds: await deptIds(req, f) })).filter((j) => j.status !== 'REJECTED');
  const chem = await chemLines(req.user.companyId, {});
  const m = new Map();
  for (const j of jobs) {
    const key = `${ymd(j.jobDate)}|${j.department}`;
    const r = m.get(key) || m.set(key, { date: ymd(j.jobDate), department: j.department, jobs: new Set(), soCards: new Set(), thaans: 0, meters: 0, cost: 0 }).get(key);
    r.jobs.add(j.jobId); r.soCards.add(j.soCardId); r.thaans += nz(j.thaans); r.meters += j.meters;
    r.cost += chem.filter((l) => l.jobId === j.jobId && l.soCardId === j.soCardId).reduce((t, l) => t + l.amount, 0);
  }
  const rows = [...m.values()].map((r) => ({ date: r.date, department: r.department, jobs: r.jobs.size, soCards: r.soCards.size, thaans: r.thaans, meters: round(r.meters), cost: round(r.cost) }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.department.localeCompare(b.department));
  const columns = [col('date', 'Date', 'date'), col('department', 'Department'), col('jobs', 'Jobs', 'number'), col('soCards', 'SO cards', 'number'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number'), col('cost', 'Chemical cost', 'money')];
  return respond('Department day by day', f, [section('daily', 'Department day by day', columns, rows, ['jobs', 'thaans', 'meters', 'cost'])], f);
}

module.exports = { qualityWise, partyCost, gradeSummary, ageing, pendingJobs, deliveryDue, reworkJobs, departmentDaily };
