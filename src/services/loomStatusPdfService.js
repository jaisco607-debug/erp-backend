// The two PDFs of the Looms Status page (Sizing > Beams & Looms): "PDF by quality" (every running loom under its quality) and "Quality summary" (one line per quality).
// They read the same figures as the status list (loomBeamService.entriesOf), so the printed numbers always agree with the screen.
const PDFDocument = require('pdfkit');
const { sequelize, Company } = require('../models');
const AppError = require('../utils/AppError');
const { ZONE, today } = require('../utils/dates');
const { entriesOf } = require('./loomBeamService');

const q = (sql, replacements) => sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
const n0 = (v) => Math.round(Number(v) || 0).toLocaleString('en-US');
const dmy = (ymd) => (ymd ? `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(2, 4)}` : '');
const dmyFull = (ymd) => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`;
const NO_QUALITY = 'No quality';
const NEARLY_DONE_PCT = 10; // "beams nearly done": 10% or less left
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function collect(doc) {
  return new Promise((resolve, reject) => { const c = []; doc.on('data', (x) => c.push(x)); doc.on('end', () => resolve(Buffer.concat(c))); doc.on('error', reject); });
}

/** The running entries (with or without beams) of a department, grouped by quality, with the figures of each group. */
async function load(req, departmentId) {
  const { companyId } = req.user;
  let dept = null;
  if (departmentId) {
    [dept] = await q('SELECT id, name FROM weaving_departments WHERE id = :departmentId AND "companyId" = :companyId', { departmentId, companyId });
    if (!dept) throw AppError.notFound('Department');
  }
  const ids = (await q(`SELECT e.id FROM loom_entries e JOIN looms l ON l.id = e."loomId" WHERE e."companyId" = :companyId AND e.status = 'ACTIVE'${dept ? ' AND l."departmentId" = :departmentId' : ''}`, { companyId, departmentId: dept && dept.id })).map((x) => x.id);
  const all = ids.length ? await entriesOf('e.id IN (:ids)', { ids }) : [];
  const company = (await Company.findByPk(companyId));
  const groups = new Map();
  for (const e of all) {
    const name = e.quality || NO_QUALITY;
    const g = groups.get(name) || { quality: name, entries: [] };
    g.entries.push({ ...e, noPlan: e.missingSetup || !(e.perDayM > 0) });
    groups.set(name, g);
  }
  const list = [...groups.values()].map((g) => {
    g.entries.sort((a, b) => natural(a.loom.loomNo, b.loom.loomNo));
    const sum = (k) => g.entries.reduce((t, e) => t + (e[k] || 0), 0);
    const beamLength = sum('netLengthM'); const produced = sum('producedM'); const balance = sum('balanceM'); const perDay = sum('perDayM');
    const ends = g.entries.map((e) => e.endsOn).filter(Boolean).sort();
    return { ...g, looms: g.entries.length, beamLength, produced, balance, perDay, donePct: beamLength ? Math.round((produced / beamLength) * 100) : 0,
      daysToFinish: perDay > 0 ? Math.ceil(balance / perDay) : null, firstEnds: ends[0] || null };
  }).sort((a, b) => b.beamLength - a.beamLength);
  const total = list.reduce((t, g) => ({ looms: t.looms + g.looms, beamLength: t.beamLength + g.beamLength, produced: t.produced + g.produced, balance: t.balance + g.balance, perDay: t.perDay + g.perDay }), { looms: 0, beamLength: 0, produced: 0, balance: 0, perDay: 0 });
  total.donePct = total.beamLength ? Math.round((total.produced / total.beamLength) * 100) : 0;
  const entries = list.flatMap((g) => g.entries);
  const alerts = { stale: entries.filter((e) => e.isStale).length, nearlyDone: entries.filter((e) => e.netLengthM > 0 && e.remainingPct <= NEARLY_DONE_PCT).length, noPlan: entries.filter((e) => e.noPlan).length };
  return { department: dept ? dept.name : 'All looms', company: company ? company.name : '', list, total, alerts };
}

function stamp() {
  const t = new Date().toLocaleString('en-GB', { timeZone: ZONE, hour12: false }).replace(',', '');
  const [d, h] = t.split(' ');
  const [dd, mm, yy] = d.split('/');
  return { ymd: `${yy}-${mm}-${dd}`, text: `${dd}-${mm}-${yy} ${h.slice(0, 5)}` };
}

/** One PDF: a header on every page (title, as at, company), a footer (printed time, page), and a table drawn from column specs. */
function newPdf(title, sub, company, printed) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 40, bufferPages: true });
  const done = collect(doc);
  const W = doc.page.width - 80;
  const header = () => {
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(title, 40, 36, { width: W * 0.7 });
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(sub, 40, doc.y, { width: W * 0.7 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(String(company).toUpperCase(), 40, 40, { width: W, align: 'right' });
    doc.moveTo(40, 68).lineTo(40 + W, 68).lineWidth(1.2).strokeColor('#000').stroke();
    doc.y = 76;
  };
  header();
  return { doc, W, done, header, printed };
}

function finish(p) {
  const { doc } = p;
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(`| printed ${p.printed}`, 40, doc.page.height - 30, { width: p.W / 2, lineBreak: false });
    doc.text(`Page ${i + 1}`, 40 + p.W / 2, doc.page.height - 30, { width: p.W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return p.done;
}

/** cols: [{ label, w (share), align }]; rows: arrays of text; bold rows get a grey band. Returns nothing, moves doc.y. */
function table(p, cols, rows, { bold = false, size = 8 } = {}) {
  const { doc, W } = p;
  const total = cols.reduce((t, c) => t + c.w, 0);
  const widths = cols.map((c) => (c.w / total) * W);
  const put = (cells, font) => {
    let x = 40; const y = doc.y;
    doc.font(font).fontSize(size).fillColor('#000');
    const h = Math.max(...cells.map((t, i) => doc.heightOfString(String(t), { width: widths[i] - 6 })), size) + 4;
    if (y + h > doc.page.height - 50) { doc.addPage(); p.header(); return put(cells, font); }
    cells.forEach((t, i) => { doc.text(String(t), x + 2, y + 2, { width: widths[i] - 6, align: cols[i].align || 'left' }); x += widths[i]; });
    doc.y = y + h;
    doc.moveTo(40, doc.y).lineTo(40 + W, doc.y).lineWidth(0.4).strokeColor('#bbb').stroke();
    return null;
  };
  return { widths, put, header: () => put(cols.map((c) => c.label), 'Helvetica-Bold'), row: (r, b) => put(r, b || bold ? 'Helvetica-Bold' : 'Helvetica') };
}

/** Quality summary: one line per quality, a TOTAL line, the alerts. */
async function qualitySummaryPdf(req, { departmentId }) {
  const d = await load(req, departmentId);
  const now = stamp();
  const p = newPdf(`Quality summary - ${d.department}`, `As at ${dmyFull(today())} | what is running, by fabric quality`, d.company, now.text);
  const cols = [{ label: 'Quality', w: 26 }, { label: 'Looms', w: 6, align: 'right' }, { label: 'Beam length', w: 11, align: 'right' }, { label: 'Produced', w: 10, align: 'right' }, { label: 'Done %', w: 7, align: 'right' },
    { label: 'Balance', w: 11, align: 'right' }, { label: 'Per day', w: 8, align: 'right' }, { label: 'Days to finish', w: 9, align: 'right' }, { label: 'First beam ends', w: 10, align: 'right' }];
  const t = table(p, cols, [], { size: 9 });
  t.header();
  for (const g of d.list) t.row([g.quality, g.looms, n0(g.beamLength), n0(g.produced), g.donePct, n0(g.balance), n0(g.perDay), g.daysToFinish == null ? '' : g.daysToFinish, dmy(g.firstEnds)]);
  t.row(['TOTAL', d.total.looms, n0(d.total.beamLength), n0(d.total.produced), d.total.donePct, n0(d.total.balance), n0(d.total.perDay), '', ''], true);
  p.doc.moveDown(0.8).font('Helvetica').fontSize(8).fillColor('#555').text(`Alerts: ${d.alerts.stale} looms with no production update for 3+ days, ${d.alerts.nearlyDone} beams nearly done (${NEARLY_DONE_PCT}% or less left), ${d.alerts.noPlan} without plan data (no end date).`, 40);
  const buffer = await finish(p);
  return { buffer, fileName: `loom-${slug(d.department)}-quality-summary-${now.ymd.replace(/-/g, '')}.pdf` };
}

/** PDF by quality: a block per quality (title + its figures), the looms under it, and ALL QUALITIES at the end. */
async function byQualityPdf(req, { departmentId }) {
  const d = await load(req, departmentId);
  const now = stamp();
  const p = newPdf(`Loom beam tracking by quality - ${d.department}`, `As at ${dmyFull(today())} | ${d.total.looms} running looms in ${d.list.length} ${d.list.length === 1 ? "quality" : "qualities"}`, d.company, now.text);
  const { doc, W } = p;
  const cols = [{ label: 'K#', w: 5 }, { label: 'Loom', w: 5 }, { label: 'Beam', w: 12 }, { label: 'Count', w: 10 }, { label: 'Ends', w: 6, align: 'right' }, { label: 'Started', w: 8 }, { label: 'Beam length', w: 9, align: 'right' },
    { label: 'Produced', w: 8, align: 'right' }, { label: 'Balance', w: 8, align: 'right' }, { label: 'Done %', w: 6, align: 'right' }, { label: 'Per day', w: 6, align: 'right' }, { label: 'Ends on', w: 8 }, { label: 'Alert', w: 14 }];
  const line = (g) => `${g.looms} ${g.looms === 1 ? 'loom' : 'looms'} | beam length ${n0(g.beamLength)} | produced ${n0(g.produced)} (${g.donePct}%) | balance ${n0(g.balance)} | per day ${n0(g.perDay)}`;
  for (const g of d.list) {
    if (doc.y > doc.page.height - 120) { doc.addPage(); p.header(); }
    const y = doc.y + 4;
    doc.rect(40, y, W, 16).fillColor('#f0f0f0').fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(g.quality, 46, y + 3, { width: W * 0.4, lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#555').text(line(g), 40 + W * 0.4, y + 4, { width: W * 0.6 - 6, align: 'right', lineBreak: false });
    doc.y = y + 20;
    const t = table(p, cols, [], { size: 7.5 });
    t.header();
    for (const e of g.entries) {
      const alert = [e.isStale ? 'no update 3d+' : null, e.noPlan ? 'no plan data' : null].filter(Boolean).join(', ');
      t.row([e.kId, e.loom.loomNo, e.beamNos || '', e.yarnCount || '', n0(e.ends || 0), dmy(e.startDate), n0(e.netLengthM), n0(e.producedM), n0(e.balanceM), Math.round(e.donePct), n0(e.perDayM), dmy(e.endsOn), alert]);
    }
    doc.moveDown(0.5);
  }
  if (doc.y > doc.page.height - 70) { doc.addPage(); p.header(); }
  const y = doc.y + 4;
  doc.moveTo(40, y).lineTo(40 + W, y).lineWidth(1).strokeColor('#000').stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('ALL QUALITIES', 46, y + 5, { width: W * 0.3, lineBreak: false });
  doc.text(line(d.total), 40 + W * 0.3, y + 6, { width: W * 0.7 - 6, align: 'right', lineBreak: false });
  doc.moveTo(40, y + 22).lineTo(40 + W, y + 22).stroke();
  const buffer = await finish(p);
  return { buffer, fileName: `loom-${slug(d.department)}-by-quality-${now.ymd.replace(/-/g, '')}.pdf` };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all';

module.exports = { qualitySummaryPdf, byQualityPdf };
