// Weaving Production Control > "Depart wise & efficiency report" (service WEAVING_PRODUCTION). Read only, from the units of the production register.
// One 15 day period of one department. The looms are grouped in loom blocks ("departs": 1 to 8, 9 to 18 ...) by the number in the loom no. Per day and block:
//   units       the units of the looms of the block
//   efficiency  units / (running looms x RPM x 1.44) x 100        (1 loom at 100% gives RPM x 1,440 picks a day = RPM x 1.44 units)
//               a loom is RUNNING on a day when it gave at least `minRunUnits` units that day; its RPM is the one of the beam entry (K-ID) running on it that day, else `defaultRpm`
//   "Eff total" of a day = the average of the efficiencies of the blocks; the Grand total row = the average of the days that have units.
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const { ZONE } = require('../utils/dates');
const audit = require('./auditService');
const { periodOf, department } = require('./weavingProductionService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNITS_PER_RPM_DAY = 1.44; // 1,440 minutes / 1,000 picks per unit
const DEFAULTS = { minRunUnits: 1, defaultRpm: 239, blocks: [] };

async function basisOf(companyId, departmentId) {
  const [p] = await q('SELECT blocks, "minRunUnits", "defaultRpm" FROM production_policies WHERE "companyId" = :companyId AND "departmentId" = :departmentId', { companyId, departmentId });
  if (!p) return { ...DEFAULTS };
  return { minRunUnits: Number(p.minRunUnits), defaultRpm: p.defaultRpm, blocks: (p.blocks || []).map((b) => ({ from: Number(b.from), to: Number(b.to) })).sort((a, b) => a.from - b.from) };
}

/** GET /production/efficiency/basis */
async function getBasis(req, { departmentId }) {
  const dept = await department(req.user.companyId, departmentId);
  return { department: dept, ...(await basisOf(req.user.companyId, departmentId)) };
}

/** PUT /production/efficiency/basis: the loom blocks, the units that make a loom "running", the RPM for a loom with none. */
async function setBasis(req, { departmentId, blocks, minRunUnits, defaultRpm }) {
  const { companyId } = req.user;
  await department(companyId, departmentId);
  const before = await basisOf(companyId, departmentId);
  let list = before.blocks;
  if (blocks) {
    list = [...blocks].sort((a, b) => a.from - b.from);
    for (const b of list) if (b.from > b.to) throw AppError.rule('BAD_RANGE', `Loom ${b.from} to ${b.to}: "from" is above "to"`, { field: 'blocks' });
    for (let i = 1; i < list.length; i += 1) if (list[i].from <= list[i - 1].to) throw AppError.rule('RANGE_OVERLAP', `The loom blocks ${list[i - 1].from}-${list[i - 1].to} and ${list[i].from}-${list[i].to} overlap`, { field: 'blocks' });
  }
  const next = { blocks: list, minRunUnits: minRunUnits ?? before.minRunUnits, defaultRpm: defaultRpm ?? before.defaultRpm };
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(`INSERT INTO production_policies (id, "companyId", "departmentId", blocks, "minRunUnits", "defaultRpm", "updatedById", "updatedAt")
      VALUES (:id, :companyId, :departmentId, :blocks::jsonb, :minRunUnits, :defaultRpm, :userId, now())
      ON CONFLICT ("companyId", "departmentId") DO UPDATE SET blocks = :blocks::jsonb, "minRunUnits" = :minRunUnits, "defaultRpm" = :defaultRpm, "updatedById" = :userId, "updatedAt" = now()`,
    { replacements: { id: crypto.randomUUID(), companyId, departmentId, blocks: JSON.stringify(next.blocks), minRunUnits: next.minRunUnits, defaultRpm: next.defaultRpm, userId: req.user.id }, transaction });
    await audit.log(req, { action: 'PRODUCTION_EFFICIENCY_BASIS_SET', entityType: 'ProductionPolicy', entityId: departmentId, before, after: next }, { transaction });
  });
  return getBasis(req, { departmentId });
}

const loomNumber = (no) => (/^\d+$/.test(String(no).trim()) ? Number(no) : null);
const dmy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const titleDate = (d) => `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;

/** The report of a period: per day the units and the efficiency of every loom block, the totals. */
async function report(req, { departmentId, from }) {
  const { companyId } = req.user;
  const p = periodOf(from);
  if (p.from !== from) throw AppError.rule('BAD_PERIOD', 'A period starts on the 1st or the 16th of a month', { field: 'from' });
  const dept = await department(companyId, departmentId);
  const basis = await basisOf(companyId, departmentId);
  const rep = { companyId, departmentId, from: p.from, to: p.to };
  const units = await q(`SELECT u."workDate"::text AS d, u."loomId", SUM(u.units)::float AS units FROM production_units u WHERE u."companyId" = :companyId AND u."departmentId" = :departmentId AND u."workDate" BETWEEN :from AND :to GROUP BY 1, 2`, rep);
  const looms = await q('SELECT id, "loomNo" FROM looms WHERE "companyId" = :companyId AND "departmentId" = :departmentId AND "deletedAt" IS NULL', rep);
  const entries = await q(`SELECT e."loomId", e."loomRpm", e."startDate"::text AS s, e."endDate"::text AS e FROM loom_entries e JOIN looms l ON l.id = e."loomId"
    WHERE e."companyId" = :companyId AND l."departmentId" = :departmentId AND e."isConfirmed" AND e."startDate" <= :to AND (e."endDate" IS NULL OR e."endDate" >= :from) ORDER BY e."startDate", e."kId"`, rep);
  const noOf = new Map(looms.map((l) => [l.id, l.loomNo]));

  // the blocks of the report (no block saved yet: one block with every loom)
  const nums = looms.map((l) => loomNumber(l.loomNo)).filter((n) => n != null);
  const blocks = basis.blocks.length ? basis.blocks : (nums.length ? [{ from: Math.min(...nums), to: Math.max(...nums) }] : []);
  const groups = blocks.map((b) => ({ key: `${b.from}-${b.to}`, label: `${b.from} to ${b.to}`, from: b.from, to: b.to, looms: nums.filter((n) => n >= b.from && n <= b.to).length }));
  const hasOther = units.some((u) => u.units > 0 && !groups.some((g) => { const n = loomNumber(noOf.get(u.loomId)); return n != null && n >= g.from && n <= g.to; }));
  if (hasOther) groups.push({ key: 'other', label: 'Other looms', from: null, to: null, looms: looms.filter((l) => !groups.some((g) => g.from != null && loomNumber(l.loomNo) >= g.from && loomNumber(l.loomNo) <= g.to)).length });
  const groupOf = (loomId) => {
    const n = loomNumber(noOf.get(loomId));
    const g = n == null ? null : groups.find((x) => x.from != null && n >= x.from && n <= x.to);
    return g ? g.key : (hasOther ? 'other' : null);
  };
  const rpmOn = (loomId, d) => { let rpm = null; for (const e of entries) if (e.loomId === loomId && e.s <= d && (!e.e || e.e >= d)) rpm = e.loomRpm; return rpm || basis.defaultRpm; };

  const byDay = new Map();
  for (const u of units) { const l = byDay.get(u.d) || []; l.push(u); byDay.set(u.d, l); }
  const days = []; const dates = [];
  for (const d = new Date(`${p.from}T00:00:00Z`); d <= new Date(`${p.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  const sumUnits = Object.fromEntries(groups.map((g) => [g.key, 0])); const effSum = Object.fromEntries(groups.map((g) => [g.key, { s: 0, n: 0 }]));
  let totalUnits = 0; const dayEff = { s: 0, n: 0 };
  for (const date of dates) {
    const list = byDay.get(date) || [];
    const dayUnits = list.reduce((t, u) => t + u.units, 0);
    const row = { date, weekday: WEEK[new Date(`${date}T00:00:00Z`).getUTCDay()], hasUnits: dayUnits > 0, units: {}, unitsTotal: n2(dayUnits), efficiency: {}, efficiencyTotal: null };
    const effs = [];
    for (const g of groups) {
      const mine = list.filter((u) => groupOf(u.loomId) === g.key);
      const gu = mine.reduce((t, u) => t + u.units, 0);
      row.units[g.key] = n2(gu);
      const running = mine.filter((u) => u.units >= basis.minRunUnits && u.units > 0);
      if (running.length) {
        const capacity = running.reduce((t, u) => t + rpmOn(u.loomId, date) * UNITS_PER_RPM_DAY, 0);
        const eff = (gu / capacity) * 100;
        row.efficiency[g.key] = { value: n2(eff), runningLooms: running.length, rpm: n2(running.reduce((t, u) => t + rpmOn(u.loomId, date), 0) / running.length), capacityUnits: n2(capacity), units: n2(gu) };
        effs.push(eff); effSum[g.key].s += eff; effSum[g.key].n += 1;
      } else row.efficiency[g.key] = null;
      sumUnits[g.key] += gu;
    }
    if (effs.length) { row.efficiencyTotal = n2(effs.reduce((t, v) => t + v, 0) / effs.length); dayEff.s += effs.reduce((t, v) => t + v, 0) / effs.length; dayEff.n += 1; }
    totalUnits += dayUnits;
    days.push(row);
  }
  const grand = { units: Object.fromEntries(groups.map((g) => [g.key, n2(sumUnits[g.key])])), unitsTotal: n2(totalUnits),
    efficiency: Object.fromEntries(groups.map((g) => [g.key, effSum[g.key].n ? n2(effSum[g.key].s / effSum[g.key].n) : null])), efficiencyTotal: dayEff.n ? n2(dayEff.s / dayEff.n) : null };
  return {
    department: dept, from: p.from, to: p.to, label: p.label, basis, groups, days, grand,
    title: `${dept.name.toUpperCase()} UNITS & EFFICIENCY DEPART WISE ${titleDate(p.from)} TO ${titleDate(p.to)}`,
    note: 'Efficiency = units / (running looms x RPM x 1.44) x 100. Total = average of the groups; Grand total = average of the days.',
    blocksSet: basis.blocks.length > 0,
  };
}

// ---- PDF and Excel ----
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
const f2 = (v) => (v == null ? '' : Number(v).toFixed(2));
function columns(r) {
  const cols = [{ label: 'Date', w: 9 }];
  for (const g of r.groups) cols.push({ label: `Units ${g.label}`, w: 7, kind: 'u', key: g.key });
  cols.push({ label: 'Units total', w: 8, kind: 'ut' });
  for (const g of r.groups) cols.push({ label: `Eff ${g.label}`, w: 6.5, kind: 'e', key: g.key });
  cols.push({ label: 'Eff total', w: 7, kind: 'et' });
  return cols;
}
function cells(r, cols, row, grand) {
  return cols.map((c, i) => {
    if (i === 0) return grand ? 'Grand Total' : dmy(row.date);
    const src = grand ? r.grand : row;
    if (c.kind === 'u') return n0(src.units[c.key]);
    if (c.kind === 'ut') return n0(src.unitsTotal);
    const has = grand || row.hasUnits;
    if (c.kind === 'e') { const e = src.efficiency[c.key]; return has && e ? f2(grand ? e : e.value) : ''; }
    return has ? f2(src.efficiencyTotal) : '';
  });
}
function stamp() {
  const t = new Date().toLocaleString('en-GB', { timeZone: ZONE, hour12: false }).replace(',', '');
  const [d, h] = t.split(' '); const [dd, mm, yy] = d.split('/');
  return `${dd}-${mm}-${yy} ${h.slice(0, 5)}`;
}
const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
const fileBase = (r) => `${slug(r.department.name)}-depart-${r.from.replace(/-/g, '')}`;

async function pdf(req, query) {
  const r = await report(req, query);
  const company = await Company.findByPk(req.user.companyId);
  void company;
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
  const chunks = []; const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const W = doc.page.width - 72; const PURPLE = '#85567a';
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor(PURPLE).text(r.title, 36, 32);
    doc.font('Helvetica').fontSize(8).fillColor('#555').text('Efficiency = units / (looms x 100% units per loom per day); Total = average of the groups; Grand total = average of the days', 36, doc.y);
    doc.y = 64;
  };
  header();
  const cols = columns(r); const total = cols.reduce((t, c) => t + c.w, 0); const widths = cols.map((c) => (c.w / total) * W);
  const put = (vals, { head = false, bold = false, band = false } = {}) => {
    const y = doc.y; const h = 14;
    if (y + h > doc.page.height - 50) { doc.addPage(); header(); return put(vals, { head, bold, band }); }
    if (head) doc.rect(36, y, W, h).fillColor(PURPLE).fill(); else if (band) doc.rect(36, y, W, h).fillColor('#f3eaf1').fill();
    doc.font(head || bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor(head ? '#fff' : '#000');
    let x = 36; vals.forEach((t, i) => { doc.text(String(t), x + 3, y + 3.5, { width: widths[i] - 6, align: head ? 'center' : i === 0 ? 'left' : 'right', lineBreak: false }); x += widths[i]; });
    doc.y = y + h; return null;
  };
  put(cols.map((c) => c.label), { head: true });
  r.days.forEach((d, i) => put(cells(r, cols, d, false), { band: i % 2 === 1 }));
  put(cells(r, cols, null, true), { bold: true });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(`| printed ${stamp()}`, 36, doc.page.height - 28, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1}`, 36 + W / 2, doc.page.height - 28, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return { buffer: await done, fileName: `${fileBase(r)}.pdf` };
}

async function xlsx(req, query) {
  const r = await report(req, query);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Depart wise');
  const cols = columns(r);
  const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  ws.addRow([r.title]).font = { bold: true, size: 13 };
  ws.getRow(1).eachCell((c) => { c.fill = fill('FFC6E0B4'); });
  ws.addRow([r.note]).font = { italic: true, size: 9 };
  ws.addRow([]);
  const head = ws.addRow(cols.map((c) => c.label)); head.font = { bold: true };
  head.eachCell((c) => { c.fill = fill('FFFFFF00'); c.alignment = { horizontal: 'center' }; c.border = { bottom: { style: 'thin' } }; });
  for (const d of r.days) {
    const row = ws.addRow(cols.map((c, i) => {
      if (i === 0) return dmy(d.date);
      if (c.kind === 'u') return d.units[c.key];
      if (c.kind === 'ut') return d.unitsTotal;
      if (!d.hasUnits) return i === cols.findIndex((x) => x.kind === 'e') ? 'no units' : null;
      if (c.kind === 'e') return d.efficiency[c.key] ? d.efficiency[c.key].value : null;
      return d.efficiencyTotal;
    }));
    row.getCell(1).numFmt = '@';
  }
  const g = ws.addRow(cols.map((c, i) => (i === 0 ? 'Grand Total' : c.kind === 'u' ? r.grand.units[c.key] : c.kind === 'ut' ? r.grand.unitsTotal : c.kind === 'e' ? r.grand.efficiency[c.key] : r.grand.efficiencyTotal)));
  g.font = { bold: true }; g.eachCell((c) => { c.fill = fill('FFFFFF00'); });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = i === 0 ? 14 : 13; if (i > 0) ws.getColumn(i + 1).numFmt = c.kind === 'e' || c.kind === 'et' ? '0.00' : '#,##0'; });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${fileBase(r)}.xlsx` };
}

module.exports = { report, pdf, xlsx, getBasis, setBasis };
