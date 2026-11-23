// Weaving Production Control > "Production bill / wages" (service WEAVING_PRODUCTION). Read only: the bill of every weaver for one 15 day period of a department, from the weaver
// attendance of the looms and the units of the production register, with the rates of the Loom policy (rates keep their history: a day uses the rates in force on that day).
//   Days        shifts worked (a weaver shift = a day of the weaver's pay)                 Wages = days x rate per day
//   Loom/Extra  per looms-per-weaver group: the loom-shifts up to the group size, and the looms beyond it in a shift (extra looms)
//   Extra loom  each extra loom is paid rate per day / looms in the group
//   Units       the units of the weaver's looms by loom type (PU, P7100 ...)                Production amount = units x rate per unit of the type
//   Stoppage    a loom of the weaver with no production in a shift is paid half the average units of his other looms in that shift, at its own rate (weavingBillingService.stoppages)
//   NET = total wages + production amount + stoppage amount
// The amounts of a weaver are rounded to whole rupees and the totals add up the rounded amounts.
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { ZONE } = require('../utils/dates');
const { department, natural } = require('./weavingProductionService');
const B = require('./weavingBillingService');

const n2 = (v) => Math.round(Number(v) * 100) / 100;
const r0 = Math.round;
const n0 = (v) => r0(Number(v) || 0).toLocaleString('en-US');
const dmy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;

/** The rates shown on the bill: the ones in force on the last day of the period (else the first version). */
function shownRates(policy, to) {
  const v = [...policy.versions].reverse().find((x) => x.effectiveFrom <= to) || policy.versions[0] || null;
  return { ratePerDay: v && v.ratePerDay != null ? Number(v.ratePerDay) : 0, byType: v ? v.rates : {} };
}

async function bill(req, { departmentId, from }) {
  const { companyId } = req.user;
  const p = B.bounds(from);
  const dept = await department(companyId, departmentId);
  const policy = await B.policyOf(companyId, departmentId);
  const g = await B.gather(companyId, departmentId, p);
  const typeOf = new Map(g.looms.map((l) => [l.id, l.loomType || B.NO_TYPE]));
  const types = [...new Set([...g.looms].sort((a, b) => a.code - b.code).map((l) => l.loomType).filter(Boolean))];
  const hasUntyped = g.units.some((u) => u.units > 0 && !typeOf.get(u.loomId));
  const typeKeys = hasUntyped ? [...types, B.NO_TYPE] : types;
  const groups = [...new Set([...policy.ranges.map((r) => r.loomsPerWeaver), policy.otherLooms])].sort((a, b) => b - a);
  const keyOf = (t) => t || 'OTHER';
  const shown = shownRates(policy, p.to);

  const byId = new Map(g.ws.map((w) => [w.id, w]));
  const weaverOf = new Map();
  for (const x of g.wl) weaverOf.set(`${x.d}|${x.shift}|${x.loomId}`, byId.get(x.weaverId));
  const loomsOf = new Map();
  for (const x of g.wl) loomsOf.set(x.weaverId, [...(loomsOf.get(x.weaverId) || []), x]);

  const rows = new Map();
  const rowFor = (w) => {
    if (!rows.has(w.employeeId)) {
      rows.set(w.employeeId, { employeeId: w.employeeId, code: w.code, name: w.name, label: B.labelOf(w.code, w.name), days: 0, groups: Object.fromEntries(groups.map((gr) => [gr, { loom: 0, extra: 0 }])),
        wages: 0, extraWages: 0, units: {}, amounts: {}, stoppedLooms: 0, stoppageUnits: 0, stoppageAmount: 0 });
    }
    return rows.get(w.employeeId);
  };
  // attendance and wages: every weaver shift is a day; loom-shifts up to the group size, the looms above it are extra looms (rate per day / looms in the group)
  for (const w of g.ws) {
    const r = rowFor(w);
    const rateDay = B.rateDayAt(policy, w.d);
    r.days += 1; r.wages += rateDay;
    const per = {};
    for (const x of loomsOf.get(w.id) || []) { const gr = B.perWeaverOf(policy, x.loomNo); per[gr] = (per[gr] || 0) + 1; }
    for (const [gr, n] of Object.entries(per)) {
      const size = Number(gr); const cell = r.groups[size] || (r.groups[size] = { loom: 0, extra: 0 });
      cell.loom += Math.min(n, size); cell.extra += Math.max(0, n - size);
      r.extraWages += (Math.max(0, n - size) * rateDay) / size;
    }
  }
  // units and the production amount (the rate per unit of the loom type on the day)
  let noWeaverUnits = 0; let entriesUnits = 0; let productionRaw = 0;
  for (const u of g.units) {
    entriesUnits += u.units;
    const w = weaverOf.get(`${u.d}|${u.shift}|${u.loomId}`);
    if (!w) { noWeaverUnits += u.units; continue; }
    const r = rowFor(w); const type = typeOf.get(u.loomId);
    r.units[type] = (r.units[type] || 0) + u.units;
    const amount = u.units * B.rateAt(policy, u.d, type); r.amounts[type] = (r.amounts[type] || 0) + amount; productionRaw += amount;
  }
  // stoppage: the same list as the detail
  const detail = B.stoppages(g, policy);
  for (const s of detail) { const r = rowFor(s); r.stoppedLooms += 1; r.stoppageUnits += s.stoppageUnits; r.stoppageAmount += s.amount; }

  const out = [...rows.values()].sort((a, b) => natural(a.name, b.name)).map((r, i) => {
    const wagesAmount = r0(r.wages); const extraLoomWages = r0(r.extraWages);
    const amountByType = Object.fromEntries(typeKeys.map((t) => [keyOf(t), r0(r.amounts[t] || 0)]));
    const productionAmount = Object.values(amountByType).reduce((s, v) => s + v, 0);
    const unitsByType = Object.fromEntries(typeKeys.map((t) => [keyOf(t), r0(r.units[t] || 0)]));
    const stoppageAmount = r0(r.stoppageAmount);
    const totalWages = wagesAmount + extraLoomWages;
    return {
      no: i + 1, employeeId: r.employeeId, code: r.code, name: r.name, label: r.label, days: r.days,
      groups: Object.fromEntries(groups.map((gr) => [gr, { loom: r.groups[gr].loom, extra: r.groups[gr].extra }])),
      ratePerDay: shown.ratePerDay, wagesAmount, extraLoomWages, totalWages,
      unitsByType, totalUnits: Object.values(unitsByType).reduce((s, v) => s + v, 0),
      rateByType: Object.fromEntries(typeKeys.map((t) => [keyOf(t), Number(shown.byType[t]) || 0])), amountByType, productionAmount,
      stoppedLooms: r.stoppedLooms, stoppageUnits: r0(r.stoppageUnits), stoppageAmount, net: totalWages + productionAmount + stoppageAmount,
    };
  });
  const sum = (k) => out.reduce((t, r) => t + r[k], 0);
  const totals = {
    days: sum('days'), groups: Object.fromEntries(groups.map((gr) => [gr, { loom: out.reduce((s, r) => s + r.groups[gr].loom, 0), extra: out.reduce((s, r) => s + r.groups[gr].extra, 0) }])),
    wagesAmount: sum('wagesAmount'), extraLoomWages: sum('extraLoomWages'), totalWages: sum('totalWages'),
    unitsByType: Object.fromEntries(typeKeys.map((t) => [keyOf(t), out.reduce((s, r) => s + r.unitsByType[keyOf(t)], 0)])), totalUnits: sum('totalUnits'),
    amountByType: Object.fromEntries(typeKeys.map((t) => [keyOf(t), out.reduce((s, r) => s + r.amountByType[keyOf(t)], 0)])), productionAmount: sum('productionAmount'),
    stoppedLooms: sum('stoppedLooms'), stoppageUnits: sum('stoppageUnits'), stoppageAmount: sum('stoppageAmount'), net: sum('net'),
  };
  // the checks of the chips: every figure is also worked out another way
  const detailAmount = r0(detail.reduce((s, d) => s + d.amount, 0)); const detailUnits = r0(detail.reduce((s, d) => s + d.stoppageUnits, 0));
  const loomShiftsBill = out.reduce((s, r) => s + Object.values(r.groups).reduce((t, c) => t + c.loom + c.extra, 0), 0);
  const wagesCheck = g.ws.reduce((s, w) => s + B.rateDayAt(policy, w.d), 0);
  const chk = (key, label, value, ok) => ({ key, label, value, ok });
  const billUnits = totals.totalUnits;
  const checks = [
    chk('units', 'Units: entries = bill + no weaver', r0(entriesUnits), Math.abs(entriesUnits - noWeaverUnits - out.reduce((s, r) => s + Object.values(r.unitsByType).reduce((a, v) => a + v, 0), 0)) < out.length + 1),
    chk('loomShifts', 'Loom-shifts: attendance = bill', g.wl.length, g.wl.length === loomShiftsBill),
    chk('wages', 'Wages: days x rate + extra', totals.totalWages, Math.abs(totals.wagesAmount - wagesCheck) <= out.length),
    chk('production', 'Production: units x rates', totals.productionAmount, Math.abs(totals.productionAmount - productionRaw) <= out.length * Math.max(1, typeKeys.length)),
    chk('stoppage', 'Stoppage: sum of the detail list', totals.stoppageAmount, Math.abs(totals.stoppageAmount - detailAmount) <= out.length),
    chk('stoppageUnits', 'Stoppage units: sum of the detail list', totals.stoppageUnits, Math.abs(totals.stoppageUnits - detailUnits) <= out.length),
    chk('net', 'Net: wages + production + stoppage', totals.net, totals.net === totals.totalWages + totals.productionAmount + totals.stoppageAmount),
  ];
  void billUnits;
  const noWeaverRounded = r0(noWeaverUnits);
  const ok = checks.every((c) => c.ok) && noWeaverRounded === 0;
  return {
    department: dept, from: p.from, to: p.to, label: p.label, title: `${dept.name.toUpperCase()} PRODUCTION BILL`, subtitle: `FROM ${dmy(p.from)} TO ${dmy(p.to)}`, weavers: out.length,
    groups: groups.map((gr) => ({ looms: gr, label: `${gr} Loom Group` })), types: typeKeys.map((t) => ({ key: keyOf(t), label: t || 'Other' })),
    rates: { ratePerDay: shown.ratePerDay, byType: Object.fromEntries(typeKeys.map((t) => [keyOf(t), Number(shown.byType[t]) || 0])) },
    rows: out, totals, checks, status: ok ? 'OK' : 'CHECK',
    noWeaver: { units: noWeaverRounded, message: noWeaverRounded > 0 ? `${n0(noWeaverRounded)} units have no weaver, so they are not in this bill. See the weaver wise page.` : null },
    stoppage: { count: detail.length, units: detailUnits, amount: detailAmount },
    note: `Days = shifts worked. Loom = loom-shifts up to the group size; Extra = looms beyond it in a shift, paid rate/day / looms in the group. Stoppage = a loom with no production in a shift is paid half the average units of the weaver's other looms in that shift, at its own rate. Rate/day ${n0(shown.ratePerDay)}${typeKeys.map((t) => `, ${t || 'Other'} ${Number(shown.byType[t]) || 0}`).join('')}.`,
  };
}

/** The list under the bill: every stopped loom-shift (weaver, date, shift, loom, type, running looms, average units, stoppage units, rate, amount). */
async function stoppageDetail(req, { departmentId, from }) {
  const { companyId } = req.user;
  const p = B.bounds(from);
  const dept = await department(companyId, departmentId);
  const policy = await B.policyOf(companyId, departmentId);
  const g = await B.gather(companyId, departmentId, p);
  const items = B.stoppages(g, policy).map((s) => ({ employeeId: s.employeeId, code: s.code, name: s.name, label: s.label, date: s.date, shift: s.shift, loomNo: s.loomNo, type: s.type || 'Other', runningLooms: s.runningLooms,
    avgUnits: n2(s.avgUnits), stoppageUnits: n2(s.stoppageUnits), rate: s.rate, amount: r0(s.amount) }));
  return { department: dept, from: p.from, to: p.to, label: p.label, count: items.length, units: r0(items.reduce((s, d) => s + d.stoppageUnits, 0)), amount: r0(items.reduce((s, d) => s + d.amount, 0)), items };
}

async function stoppageXlsx(req, query) {
  const d = await stoppageDetail(req, query);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Loom stoppage');
  ws.addRow([`${d.department.name.toUpperCase()} LOOM STOPPAGE DETAIL ${dmy(d.from)} TO ${dmy(d.to)}`]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const head = ws.addRow(['Weaver', 'Date', 'Shift', 'Loom', 'Type', 'Running looms', 'Avg units', 'Stoppage units (1/2)', 'Rate', 'Amount']); head.font = { bold: true };
  for (const i of d.items) ws.addRow([i.label, dmy(i.date), i.shift, i.loomNo, i.type, i.runningLooms, i.avgUnits, i.stoppageUnits, i.rate, i.amount]);
  const t = ws.addRow(['TOTAL', null, null, null, null, null, null, d.units, null, d.amount]); t.font = { bold: true };
  [30, 12, 8, 8, 10, 14, 12, 20, 8, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${slug(d.department.name)}-stoppage-${d.label.replace(/\s/g, '')}.xlsx` };
}

// ---- the printed bill: PDF and Excel (the same columns, with the letters of the formulas) ----
/** The columns with their letters: [{ key, label, band, letter, formula, get(row) , total(totals) }] in the order of the sheet. */
function layout(b) {
  const cols = [];
  let code = 97;
  const add = (c) => { cols.push({ ...c, letter: String.fromCharCode(code) }); code += 1; return String.fromCharCode(code - 1); };
  const L = {};
  L.days = add({ key: 'days', band: 'Attnd', label: 'Days', get: (r) => r.days, total: (t) => t.days });
  for (const gr of b.groups) {
    add({ key: `loom${gr.looms}`, band: 'Attnd', label: `Loom ${gr.looms}`, get: (r) => r.groups[gr.looms].loom, total: (t) => t.groups[gr.looms].loom });
    add({ key: `extra${gr.looms}`, band: 'Attnd', label: `Extra ${gr.looms}`, get: (r) => r.groups[gr.looms].extra, total: (t) => t.groups[gr.looms].extra });
  }
  L.rate = add({ key: 'rate', band: 'Wages', label: 'Rate / Day', get: (r) => r.ratePerDay, total: () => '' });
  L.amount = add({ key: 'amount', band: 'Wages', label: 'Amount', formula: `${L.days} x ${L.rate}`, get: (r) => r.wagesAmount, total: (t) => t.wagesAmount });
  L.extra = add({ key: 'extraWages', band: 'Wages', label: 'Extra Looms', get: (r) => r.extraLoomWages, total: (t) => t.extraLoomWages });
  L.totalWages = add({ key: 'totalWages', band: 'Wages', label: 'Total Wages', formula: `${L.amount} + ${L.extra}`, get: (r) => r.totalWages, total: (t) => t.totalWages });
  const unitLetters = [];
  for (const ty of b.types) { unitLetters.push(add({ key: `u:${ty.key}`, band: 'Units', label: ty.label, get: (r) => r.unitsByType[ty.key], total: (t) => t.unitsByType[ty.key] })); }
  L.totalUnits = add({ key: 'totalUnits', band: 'Units', label: 'Total', formula: unitLetters.join(' + '), get: (r) => r.totalUnits, total: (t) => t.totalUnits });
  const amountLetters = [];
  b.types.forEach((ty, i) => {
    const rate = add({ key: `rate:${ty.key}`, band: 'Production amount', label: ty.label, sub: 'Rate', get: (r) => r.rateByType[ty.key], total: () => '', fmt: 'rate' });
    amountLetters.push(add({ key: `amt:${ty.key}`, band: 'Production amount', label: `${ty.label} AMNT`, formula: `${unitLetters[i]} x ${rate}`, get: (r) => r.amountByType[ty.key], total: (t) => t.amountByType[ty.key] }));
  });
  L.prod = add({ key: 'prod', band: 'Production amount', label: 'Prod. Amnt', formula: amountLetters.join(' + '), get: (r) => r.productionAmount, total: (t) => t.productionAmount });
  add({ key: 'stopLooms', band: 'Stoppage', label: 'Stopped Looms', get: (r) => r.stoppedLooms, total: (t) => t.stoppedLooms });
  add({ key: 'stopUnits', band: 'Stoppage', label: 'Units', get: (r) => r.stoppageUnits, total: (t) => t.stoppageUnits });
  L.stop = add({ key: 'stopAmnt', band: 'Stoppage', label: 'Amnt', get: (r) => r.stoppageAmount, total: (t) => t.stoppageAmount });
  add({ key: 'net', band: 'NET', label: 'NET Amnt', formula: `${L.totalWages} + ${L.prod} + ${L.stop}`, get: (r) => r.net, total: (t) => t.net });
  return cols;
}
const fmtCell = (c, v) => (v === '' || v == null ? '' : c.fmt === 'rate' ? Number(v).toString() : n0(v));
const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';
function stamp() {
  const t = new Date().toLocaleString('en-GB', { timeZone: ZONE, hour12: false }).replace(',', '');
  const [d, h] = t.split(' '); const [dd, mm, yy] = d.split('/');
  return `${dd}-${mm}-${yy} ${h.slice(0, 5)}`;
}

async function pdf(req, query) {
  const b = await bill(req, query);
  const cols = layout(b);
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24, bufferPages: true });
  const chunks = []; const done = new Promise((resolve, reject) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const W = doc.page.width - 48;
  const fixed = [{ w: 2.2 }, { w: 12 }];
  const weights = cols.map((c) => (/Group|Extra|Looms|Days/.test(c.label) && c.band === 'Attnd' ? 3.2 : c.key === 'net' ? 5.6 : c.key.startsWith('rate') ? 3.4 : 4.6));
  const total = fixed.reduce((s, x) => s + x.w, 0) + weights.reduce((s, x) => s + x, 0);
  const widths = [...fixed.map((x) => (x.w / total) * W), ...weights.map((x) => (x / total) * W)];
  const xs = widths.reduce((a, w, i) => { a.push((a[i] || 24) + w); return a; }, [24]);
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(b.title, 24, 24, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).text(b.subtitle, 24, doc.y, { width: W, align: 'center' });
    doc.y += 6;
  };
  header();
  const line = (y, x1 = 24, x2 = 24 + W) => doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.5).strokeColor('#000').stroke();
  const cell = (i, y, h, text, o = {}) => {
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 6.5).fillColor('#000');
    doc.text(String(text), xs[i] + 1.5, y + (o.pad == null ? 3 : o.pad), { width: widths[i] - 3, align: o.align || 'right', lineBreak: false });
  };
  const drawHeader = () => {
    const y0 = doc.y; const h1 = 13; const h2 = 22; const h3 = 11;
    doc.rect(24, y0, W, h1 + h2 + h3).fillColor('#f2f2f2').fill();
    // the bands
    let i = 2;
    while (i < xs.length - 1) {
      const band = cols[i - 2].band;
      let end = i; while (end < xs.length - 1 && cols[end - 2].band === band) end += 1;
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text(band, xs[i], y0 + 3, { width: xs[end] - xs[i], align: 'center', lineBreak: false });
      i = end;
    }
    doc.font('Helvetica-Bold').fontSize(7).text('No', xs[0], y0 + 14, { width: widths[0], align: 'center', lineBreak: false });
    doc.text('Weaver Name', xs[1], y0 + 14, { width: widths[1], align: 'center', lineBreak: false });
    cols.forEach((c, k) => {
      const i2 = k + 2; const label = c.sub ? `${c.label} ${c.sub}` : c.label;
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#000').text(label, xs[i2] + 1, y0 + h1 + 1, { width: widths[i2] - 2, align: 'center', height: h2 - 2 });
      doc.font('Helvetica-Bold').fontSize(6.5).text(c.formula ? `${c.letter} = ${c.formula}` : c.letter, xs[i2] + 1, y0 + h1 + h2 + 2, { width: widths[i2] - 2, align: 'center', lineBreak: false });
    });
    line(y0); line(y0 + h1 + h2 + h3);
    doc.y = y0 + h1 + h2 + h3;
  };
  drawHeader();
  const ROW = 11.5;
  const rowAt = (cells, { bold = false } = {}) => {
    if (doc.y + ROW > doc.page.height - 60) { doc.addPage(); header(); drawHeader(); }
    const y = doc.y;
    cells.forEach((t, i) => cell(i, y, ROW, t, { bold, align: i === 1 ? 'left' : 'right', pad: 2.5 }));
    doc.y = y + ROW; line(doc.y, 24, 24 + W);
  };
  b.rows.forEach((r) => rowAt([r.no, r.label, ...cols.map((c) => fmtCell(c, c.get(r)))]));
  rowAt(['', 'TOTAL', ...cols.map((c) => fmtCell(c, c.total(b.totals)))], { bold: true });
  doc.moveDown(0.6).font('Helvetica').fontSize(6.5).fillColor('#333').text(b.note, 24, doc.y + 3, { width: W });
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(`| printed ${stamp()}`, 24, doc.page.height - 26, { width: W / 2, lineBreak: false });
    doc.text(`Page ${i + 1}`, 24 + W / 2, doc.page.height - 26, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return { buffer: await done, fileName: `${slug(b.department.name)}-bill-${b.label.replace(/\s/g, '')}.pdf` };
}

async function xlsx(req, query) {
  const b = await bill(req, query);
  const cols = layout(b);
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Production bill');
  ws.addRow([b.title]).font = { bold: true, size: 13 }; ws.addRow([b.subtitle]); ws.addRow([]);
  const bandRow = ws.addRow(['', '', ...cols.map((c) => c.band)]); bandRow.font = { bold: true };
  const head = ws.addRow(['No', 'Weaver Name', ...cols.map((c) => (c.sub ? `${c.label} ${c.sub}` : c.label))]); head.font = { bold: true };
  const letters = ws.addRow(['', '', ...cols.map((c) => (c.formula ? `${c.letter} = ${c.formula}` : c.letter))]); letters.font = { bold: true };
  const grey = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  [bandRow, head, letters].forEach((r) => r.eachCell((c) => { c.fill = grey; c.alignment = { horizontal: 'center', wrapText: true }; }));
  for (const r of b.rows) ws.addRow([r.no, r.label, ...cols.map((c) => c.get(r))]);
  const t = ws.addRow(['', 'TOTAL', ...cols.map((c) => { const v = c.total(b.totals); return v === '' ? null : v; })]); t.font = { bold: true };
  ws.addRow([]); ws.addRow([b.note]).font = { italic: true, size: 9 };
  ws.getColumn(1).width = 5; ws.getColumn(2).width = 30;
  cols.forEach((c, i) => { ws.getColumn(i + 3).width = c.key === 'net' ? 14 : 12; if (!c.key.startsWith('rate')) ws.getColumn(i + 3).numFmt = '#,##0'; });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `${slug(b.department.name)}-bill-${b.label.replace(/\s/g, '')}.xlsx` };
}

module.exports = { bill, stoppageDetail, stoppageXlsx, pdf, xlsx };
