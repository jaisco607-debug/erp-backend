// Reports hub (2026-10-23): the menu of the Reports tab (GET /v1/reports), the Overview report and two
// reports the tab needs that did not exist: grey given back, and SO card lots / thaans.
// Same answer shape as reportService: { title, sections: [{ key, title, columns, rows, totals }], page, limit, total }.
const AppError = require('../utils/AppError');
const { companyServices, userServices } = require('./accessService');
const { _x } = require('./reportService');

const { q, round, col, section, respond, clothNow, chemLines, needAnyService, STATUS_TEXT, CARD_POSITIONS, cardPositions, positionKey } = _x;

const COMMON = ['page', 'limit', 'dateFrom', 'dateTo'];
/** Every report of the tab. dataCodes: the data services that also open it; depts: any department service opens it. */
const REPORTS = [
  { key: 'overview', title: 'Overview', url: '/v1/reports/overview', reportCode: 'REPORT_OVERVIEW', dataCodes: ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'FOLDING', 'PACKING'], filters: ['dateFrom', 'dateTo'] },
  { key: 'grey-parties', title: 'Grey: party wise', url: '/v1/reports/grey/parties', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD'], filters: [...COMMON, 'customerId', 'search'] },
  { key: 'grey-lots', title: 'Grey: lot wise', url: '/v1/reports/grey/lots', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'stock', 'search'] },
  { key: 'grey-returns', title: 'Grey: given back', url: '/v1/reports/grey/returns', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'search'] },
  { key: 'so-cards', title: 'SO cards', url: '/v1/reports/so-cards', reportCode: 'REPORT_SO_CARDS', dataCodes: ['SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'departmentId', 'status', 'search'] },
  { key: 'so-card-lots', title: 'SO cards: lots and thaans', url: '/v1/reports/so-cards/lots', reportCode: 'REPORT_SO_CARDS', dataCodes: ['SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'status', 'search'] },
  { key: 'departments', title: 'Departments summary', url: '/v1/reports/departments', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'customerId'] },
  { key: 'department-jobs', title: 'Departments: job wise', url: '/v1/reports/departments/jobs', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'fromDepartmentId', 'customerId', 'qualityId', 'status', 'operatorName', 'search'] },
  { key: 'department-operators', title: 'Departments: operators', url: '/v1/reports/departments/operators', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'operatorName'] },
  { key: 'chemical-cost', title: 'Chemical costing', url: '/v1/reports/chemical-cost', reportCode: 'REPORT_CHEMICAL_COST', dataCodes: ['CHEMICAL_STORE'], depts: true, filters: [...COMMON, 'departmentId', 'by'] },
  { key: 'ledger', title: 'Cloth ledger (every event)', url: '/v1/reports/ledger', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD', 'PACKING'], filters: [...COMMON, 'customerId', 'soNo', 'search'] },
  { key: 'daily-stock', title: 'Day to day stock', url: '/v1/reports/daily-stock', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD', 'PACKING'], filters: [...COMMON, 'customerId'] },
  { key: 'quality-wise', title: 'Quality wise', url: '/v1/reports/quality-wise', reportCode: 'REPORT_SO_CARDS', dataCodes: ['GREY_STORE', 'SO_CARD', 'PACKING'], filters: [...COMMON, 'customerId', 'qualityId'] },
  { key: 'party-cost', title: 'Party wise cost', url: '/v1/reports/party-cost', reportCode: 'REPORT_SO_CARDS', dataCodes: ['SO_CARD', 'PACKING', 'CHEMICAL_STORE'], filters: [...COMMON, 'customerId', 'qualityId'] },
  { key: 'grade-summary', title: 'Grade summary (A / B / CP)', url: '/v1/reports/grade-summary', reportCode: 'REPORT_PACKING', dataCodes: ['PACKING'], filters: ['customerId', 'qualityId', 'by'] },
  { key: 'ageing', title: 'Cloth ageing', url: '/v1/reports/ageing', reportCode: 'REPORT_ACTIVE_FABRIC', dataCodes: ['GREY_STORE', 'SO_CARD', 'FOLDING'], filters: ['customerId'] },
  { key: 'pending-jobs', title: 'Pending jobs', url: '/v1/reports/pending-jobs', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'customerId', 'status'] },
  { key: 'delivery-due', title: 'Delivery due', url: '/v1/reports/delivery-due', reportCode: 'REPORT_SO_CARDS', dataCodes: ['SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'stock'] },
  { key: 'rework-jobs', title: 'Re-work and rejected jobs', url: '/v1/reports/rework-jobs', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'customerId'] },
  { key: 'departments-daily', title: 'Department day by day', url: '/v1/reports/departments-daily', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'customerId'] },
  { key: 'ledger-lot', title: 'Ledger: lot', url: '/v1/reports/ledgers/lot', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD'], filters: [...COMMON, 'customerId', 'qualityId', 'search'] },
  { key: 'ledger-party', title: 'Ledger: party (cloth and money)', url: '/v1/reports/ledgers/party', reportCode: 'REPORT_GREY', dataCodes: ['GREY_STORE', 'SO_CARD', 'PACKING'], filters: [...COMMON, 'customerId'] },
  { key: 'ledger-so-card', title: 'Ledger: SO card', url: '/v1/reports/ledgers/so-card', reportCode: 'REPORT_SO_CARDS', dataCodes: ['SO_CARD', 'PACKING'], filters: [...COMMON, 'customerId', 'soNo'] },
  { key: 'ledger-department', title: 'Ledger: department', url: '/v1/reports/ledgers/department', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'customerId', 'soNo'] },
  { key: 'ledger-operator', title: 'Ledger: operator', url: '/v1/reports/ledgers/operator', reportCode: 'REPORT_DEPARTMENTS', depts: true, filters: [...COMMON, 'departmentId', 'operatorName', 'customerId'] },
  { key: 'ledger-cost', title: 'Ledger: chemical cost', url: '/v1/reports/ledgers/cost', reportCode: 'REPORT_CHEMICAL_COST', dataCodes: ['CHEMICAL_STORE'], depts: true, filters: [...COMMON, 'customerId', 'soNo', 'departmentId', 'itemId'] },
  { key: 'audit-check', title: 'Audit check (reconciliation)', url: '/v1/reports/audit-check', reportCode: 'REPORT_OVERVIEW', dataCodes: ['GREY_STORE', 'SO_CARD', 'PACKING'], filters: ['customerId', 'status'] },
  { key: 'folding', title: 'Folding', url: '/v1/reports/folding', reportCode: 'REPORT_FOLDING', dataCodes: ['FOLDING'], filters: [...COMMON, 'customerId', 'search'] },
  { key: 'active-fabric', title: 'Active fabric (now)', url: '/v1/reports/active-fabric', reportCode: 'REPORT_ACTIVE_FABRIC', dataCodes: ['GREY_STORE', 'SO_CARD', 'FOLDING'], depts: true, filters: ['customerId', 'departmentId', 'tab', 'by'] },
  { key: 'packing-lists', title: 'Packing lists', url: '/v1/reports/packing-lists', reportCode: 'REPORT_PACKING', dataCodes: ['PACKING'], filters: [...COMMON, 'customerId', 'qualityId', 'status', 'gatePass', 'search'] },
  { key: 'packing-lines', title: 'Packing lists: thaan wise', url: '/v1/reports/packing-lists/lines', reportCode: 'REPORT_PACKING', dataCodes: ['PACKING'], filters: [...COMMON, 'customerId', 'qualityId', 'status', 'gatePass', 'grade', 'search'] },
  { key: 'gate-passes', title: 'Gate passes', url: '/v1/reports/gate-passes', reportCode: 'REPORT_GATE_PASSES', dataCodes: ['PACKING', 'GATE_PASS'], filters: [...COMMON, 'customerId', 'search'] },
];

const SO_CARD_STATUSES = CARD_POSITIONS.map(([value, text]) => ({ value, text }));
const JOB_STATUSES = ['IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'].map((value) => ({ value, text: STATUS_TEXT[value] }));

/** The services (id, code, kind) the person works with. */
async function myServices(req) {
  if (!req.user || !req.user.companyId) throw AppError.forbidden();
  if (req.user.userType === 'CLIENT_ADMIN') return companyServices(req.user.companyId);
  return (await userServices(req.user)).map((g) => g.service);
}

/** GET /v1/reports: the reports the person may open, with the data of the filter drop-downs. */
async function index(req) {
  const mine = await myServices(req);
  const codes = new Set(mine.map((s) => s.code));
  const anyDept = mine.some((s) => ['PROCESS', 'FOLDING', 'PACKING'].includes(s.kind));
  const allowed = REPORTS.filter((r) => codes.has(r.reportCode) || (r.dataCodes || []).some((c) => codes.has(c)) || (r.depts && anyDept));
  if (!allowed.length) throw AppError.forbidden('You do not have any report');
  const companyId = req.user.companyId;
  const [customers, qualities] = await Promise.all([
    q('SELECT id, name, code FROM customers WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY name', { companyId }),
    q('SELECT id, name FROM qualities WHERE "companyId" = :companyId AND "deletedAt" IS NULL ORDER BY name', { companyId }),
  ]);
  const all = await companyServices(companyId);
  const seeAllDepts = req.user.userType === 'CLIENT_ADMIN' || mine.some((s) => s.code.startsWith('REPORT_'));
  const departments = all.filter((s) => ['PROCESS', 'FOLDING', 'PACKING'].includes(s.kind) && (seeAllDepts || codes.has(s.code)))
    .map((s) => ({ id: s.id, name: s.name, code: s.code }));
  return {
    reports: allowed.map(({ key, title, url, filters }) => ({ key, title, url, filters })),
    customers, qualities, departments, soCardStatuses: SO_CARD_STATUSES, jobStatuses: JOB_STATUSES,
  };
}

/** Overview: the whole mill on one screen (no paging). */
async function overview(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'FOLDING', 'PACKING']);
  const companyId = req.user.companyId;
  const range = (col) => {
    const w = []; const r = {};
    if (f.dateFrom) { w.push(`${col} >= :dateFrom`); r.dateFrom = f.dateFrom; }
    if (f.dateTo) { w.push(`${col} <= :dateTo`); r.dateTo = f.dateTo; }
    return { sql: w.length ? ` AND ${w.join(' AND ')}` : '', r };
  };
  const g = range('gl."inwardDate"');
  const [grey] = await q(`SELECT count(*)::int AS lots, COALESCE(SUM(gl."inwardMeters"), 0)::float AS came, COALESCE(SUM(gl."inwardMeters" - gl."outwardMeters"), 0)::float AS "inStore",
      COALESCE(SUM(gl."returnedMeters"), 0)::float AS "givenBack"
    FROM grey_lots gl WHERE gl."companyId" = :companyId AND gl."deletedAt" IS NULL AND gl."isApproved"${g.sql}`, { companyId, ...g.r });
  const s = range('sc."cardDate"');
  const allCards = await q(`SELECT sc.id, sc."isGreyReturn", sc."totalMeters"::float AS meters FROM so_cards sc WHERE sc."companyId" = :companyId AND sc."deletedAt" IS NULL${s.sql}`, { companyId, ...s.r });
  const pos = await cardPositions(companyId);
  const normal = allCards.filter((c) => !c.isGreyReturn);
  const inPos = (key) => normal.filter((c) => (pos.get(c.id) || {}).key === key);
  const p = range('p."listDate"');
  const [pack] = await q(`SELECT count(*) FILTER (WHERE p.status = 'FINAL')::int AS "finalLists", count(*) FILTER (WHERE p.status <> 'FINAL')::int AS "draftLists",
      COALESCE(SUM((SELECT SUM(l.meters) FROM packing_list_lines l WHERE l."packingListId" = p.id)), 0)::float AS meters,
      COALESCE(SUM((SELECT count(*) FROM gate_passes g WHERE g."packingListId" = p.id)), 0)::int AS "gatePasses"
    FROM packing_lists p WHERE p."companyId" = :companyId${p.sql}`, { companyId, ...p.r });
  const cost = (await chemLines(companyId, { dateFrom: f.dateFrom, dateTo: f.dateTo })).reduce((t, l) => t + l.amount, 0);
  const now = await clothNow(companyId);
  const sum = (arr) => round(arr.reduce((t, n) => t + n.meters, 0));

  const metric = [
    ['Grey lots received', grey.lots, 'lots'], ['Grey received', round(grey.came), 'm'], ['Grey in store', round(grey.inStore), 'm'], ['Grey given back', round(grey.givenBack), 'm'],
    ['SO cards', normal.length, 'cards'], ...CARD_POSITIONS.map(([key, text]) => [`SO cards: ${text.toLowerCase()}`, inPos(key).length, 'cards']),
    ['Fabric returns (grey)', allCards.filter((c) => c.isGreyReturn).length, 'cards'],
    ['Cloth in process now', sum(now.filter((n) => n.stageKind === 'DEPARTMENT')), 'm'], ['Cloth at Packing now', sum(now.filter((n) => n.stageKind === 'PACKING')), 'm'],
    ['Packing lists (final)', pack.finalLists, 'lists'], ['Packing lists (draft)', pack.draftLists, 'lists'], ['Packed', round(pack.meters), 'm'], ['Gate passes', pack.gatePasses, 'passes'],
    ['Chemical cost', round(cost), 'Rs'],
  ].map(([metricName, value, unit]) => ({ metric: metricName, value, unit }));

  const stageMap = new Map();
  for (const n of now) {
    const k = n.stage;
    const e = stageMap.get(k) || { stage: k, lots: new Set(), soCards: new Set(), thaans: 0, meters: 0 };
    e.lots.add(n.lotId); if (n.soCardId) e.soCards.add(n.soCardId); e.thaans += n.thaans || 0; e.meters += n.meters;
    stageMap.set(k, e);
  }
  const stages = [...stageMap.values()].map((e) => ({ stage: e.stage, lots: e.lots.size, soCards: e.soCards.size, thaans: e.thaans, meters: round(e.meters) })).sort((a, b) => b.meters - a.meters);

  const out = respond('Overview', f, [
    section('summary', 'Summary', [col('metric', 'Item'), col('value', 'Value', 'number'), col('unit', 'Unit')], metric),
    section('stages', 'Where the cloth is now', [col('stage', 'Place'), col('lots', 'Lots', 'number'), col('soCards', 'SO cards', 'number'), col('thaans', 'Thaans', 'number'), col('meters', 'Meters', 'number')], stages, ['thaans', 'meters']),
    section('soCardStatus', 'SO cards by status', [col('statusText', 'Status'), col('cards', 'SO cards', 'number'), col('meters', 'Meters', 'number')],
      SO_CARD_STATUSES.map((st) => ({ statusText: st.text, cards: inPos(st.value).length, meters: round(inPos(st.value).reduce((t, c) => t + c.meters, 0)) })), ['cards', 'meters']),
  ], { export: true });
  return out;
}

/** Grey given back to the party: one row per return. */
async function greyReturns(req, f) {
  await needAnyService(req, ['GREY_STORE', 'SO_CARD']);
  const where = ['r."companyId" = :companyId'];
  const rep = { companyId: req.user.companyId };
  if (f.customerId) { where.push('gl."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.qualityId) { where.push('gl."qualityId" = :qualityId'); rep.qualityId = f.qualityId; }
  if (f.dateFrom) { where.push('r."returnDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('r."returnDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.search) { where.push('(r."returnNo"::text = :search OR gl."lotNo"::text = :search OR gl."dcNo" ILIKE :like OR cu.name ILIKE :like OR r."vehicleNo" ILIKE :like)'); rep.search = f.search; rep.like = `%${f.search}%`; }
  const rows = await q(`SELECT r."returnNo", r."returnDate", gl."lotNo", gl."typeNo", gl."dcNo", cu.name AS party, qu.name AS quality, r.pieces AS thaans, r.meters::float AS meters,
      r."vehicleNo", r.remarks,
      (SELECT string_agg(t."thaanNo"::text, ', ' ORDER BY t."thaanNo") FROM grey_lot_thaans t WHERE t."returnId" = r.id) AS "thaanNos"
    FROM grey_returns r JOIN grey_lots gl ON gl.id = r."lotId" JOIN customers cu ON cu.id = gl."customerId" LEFT JOIN qualities qu ON qu.id = gl."qualityId"
    WHERE ${where.join(' AND ')} ORDER BY r."returnNo" DESC`, rep);
  const columns = [col('returnNo', 'Return#', 'number'), col('returnDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'), col('lotNo', 'Lot#', 'number'), col('typeNo', 'Type#'), col('dcNo', 'DC#'),
    col('thaans', 'Thaans', 'number'), col('thaanNos', 'Thaan numbers', 'list'), col('meters', 'Meters', 'number'), col('vehicleNo', 'Vehicle'), col('remarks', 'Remarks')];
  return respond('Grey given back', f, [section('returns', 'Grey given back', columns, rows.map((r) => ({ ...r, meters: round(r.meters) })), ['thaans', 'meters'])], f);
}

/** SO cards with every lot and its thaans: one row per card and lot. */
async function soCardLots(req, f) {
  await needAnyService(req, ['SO_CARD']);
  const where = ['sc."companyId" = :companyId', 'sc."deletedAt" IS NULL'];
  const rep = { companyId: req.user.companyId };
  if (f.customerId) { where.push('sc."customerId" = :customerId'); rep.customerId = f.customerId; }
  if (f.qualityId) { where.push('COALESCE(sc."qualityId", gl."qualityId") = :qualityId'); rep.qualityId = f.qualityId; }
  if (f.soNo) { where.push('sc."cardNo" = :soNo'); rep.soNo = f.soNo; }
  if (f.isGreyReturn !== undefined) { where.push('sc."isGreyReturn" = :gr'); rep.gr = f.isGreyReturn; }
  if (f.dateFrom) { where.push('sc."cardDate" >= :dateFrom'); rep.dateFrom = f.dateFrom; }
  if (f.dateTo) { where.push('sc."cardDate" <= :dateTo'); rep.dateTo = f.dateTo; }
  if (f.search) { where.push('(sc."cardNo"::text = :search OR gl."lotNo"::text = :search OR gl."dcNo" ILIKE :like OR cu.name ILIKE :like)'); rep.search = f.search; rep.like = `%${f.search}%`; }
  const rows = await q(`SELECT sc.id AS "soCardId", sc."cardNo" AS "soNo", sc."isGreyReturn", sc."cardDate", sc.status, cu.name AS party, qu.name AS quality,
      gl."lotNo", gl."typeNo", gl."dcNo", scl.meters::float AS meters,
      (SELECT count(*)::int FROM so_card_lot_thaans p WHERE p."soCardLotId" = scl.id) AS thaans,
      (SELECT string_agg(t."thaanNo"::text, ', ' ORDER BY t."thaanNo") FROM so_card_lot_thaans p JOIN grey_lot_thaans t ON t.id = p."thaanId" WHERE p."soCardLotId" = scl.id) AS "thaanNos"
    FROM so_card_lots scl JOIN so_cards sc ON sc.id = scl."soCardId" JOIN grey_lots gl ON gl.id = scl."greyLotId" JOIN customers cu ON cu.id = sc."customerId"
    LEFT JOIN qualities qu ON qu.id = COALESCE(sc."qualityId", gl."qualityId")
    WHERE ${where.join(' AND ')} ORDER BY sc."cardNo" DESC, gl."lotNo"`, rep);
  const columns = [col('soNo', 'SO#', 'number'), col('cardDate', 'Date', 'date'), col('party', 'Party'), col('quality', 'Quality'), col('lotNo', 'Lot#', 'number'), col('typeNo', 'Type#'), col('dcNo', 'DC#'),
    col('thaans', 'Thaans', 'number'), col('thaanNos', 'Thaan numbers', 'list'), col('meters', 'Meters', 'number'), col('statusText', 'Status'), col('tag', 'Tag', 'tag')];
  const pos = await cardPositions(req.user.companyId);
  const data = rows.filter((r) => !f.status || (pos.get(r.soCardId) || {}).key === positionKey(f.status)).map((r) => ({ ...r, meters: round(r.meters), status: (pos.get(r.soCardId) || {}).key || 'RETURN', statusText: (pos.get(r.soCardId) || { text: 'Fabric return' }).text, tag: r.isGreyReturn ? 'Fabric return grey (not processed)' : '' }));
  return respond('SO cards: lots and thaans', f, [section('lots', 'Lots and thaans', columns, data, ['thaans', 'meters'])], f);
}

module.exports = { index, overview, greyReturns, soCardLots, REPORTS };
