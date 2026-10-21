// Shared set-up for the audit tests: a company with every service, its client admin, and short helpers to build
// the real flow (customer, lot, SO card, jobs through departments, store stock, chemical requests, packing).
// checkInvariants() runs every accounting rule of scripts/audit/invariants.js on the test database.
const { app, request, clean, makeUser, makeCompany, loginAs } = require('../helpers');
const { Service, CompanyService, UserService, sequelize } = require('../../src/models');
const rules = require('../../scripts/audit/invariants');

const ALL_SERVICES = [
  'GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'GENERAL_STORE', 'STORE_REPORTS', 'SINGEING', 'DYEING', 'DRYER', 'FINISHING', 'STITCHING',
  'CUTTING', 'PRINTING', 'STENTER', 'COMPACTING', 'FOLDING', 'PACKING', 'GATE_PASS',
  'REPORT_OVERVIEW', 'REPORT_GREY', 'REPORT_SO_CARDS', 'REPORT_DEPARTMENTS', 'REPORT_CHEMICAL_COST', 'REPORT_FOLDING', 'REPORT_ACTIVE_FABRIC', 'REPORT_PACKING', 'REPORT_GATE_PASSES',
];

/** Every rule on the test database: [{ id, title, severity, rows }] for the rules that are broken. */
async function checkInvariants(skip = []) {
  const broken = [];
  for (const r of rules) {
    if (skip.includes(r.id)) continue;
    const rows = await sequelize.query(r.sql, { type: sequelize.QueryTypes.SELECT });
    if (rows.length) broken.push({ id: r.id, title: r.title, severity: r.severity, rows: rows.slice(0, 5) });
  }
  return broken;
}

/** Jest: fails with the broken rules and their rows when any rule is broken. */
async function expectClean(skip = []) {
  const broken = await checkInvariants(skip);
  if (broken.length) throw new Error(`Accounting rules broken:\n${broken.map((b) => `  ${b.id} [${b.severity}] ${b.title}\n    ${JSON.stringify(b.rows)}`).join('\n')}`);
}

async function world(services = ALL_SERVICES) {
  const company = await makeCompany({ name: 'Audit Mills' });
  const s = {};
  for (const code of services) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const as = (authHeader) => (method, url, body) => request(app)[method](`/api/v1${url}`).set(authHeader).send(body);
  const raw = as(auth);
  const w = { company, admin, s, as, auth };
  // w.track = [] turns on a record of every changing call and how many audit rows it wrote
  const api = async (method, url, body) => {
    if (!w.track || method === 'get') return raw(method, url, body);
    const count = async () => (await sequelize.query('SELECT count(*)::int AS n FROM audit_logs', { type: sequelize.QueryTypes.SELECT }))[0].n;
    const before = await count();
    const res = await raw(method, url, body);
    w.track.push({ method, url, status: res.status, audit: (await count()) - before });
    return res;
  };
  w.api = api;

  /** body of a call that must succeed */
  w.ok = async (method, url, body, status) => {
    const res = await api(method, url, body);
    const good = status ? res.status === status : res.status >= 200 && res.status < 300;
    if (!good) throw new Error(`${method.toUpperCase()} ${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
    return res.body;
  };
  /** error code of a call that must be refused */
  w.err = async (method, url, body) => {
    const res = await api(method, url, body);
    if (res.status < 400) throw new Error(`${method.toUpperCase()} ${url} should have failed but gave ${res.status}`);
    return res.body.error ? res.body.error.code : `HTTP_${res.status}`;
  };

  w.customer = (name = 'AZ') => w.ok('post', '/customers', { name });
  w.quality = (name = 'PC TWILL') => w.ok('post', '/qualities', { name });
  /** a grey lot: thaans [100, 120] or meters + pieces; approved unless approve === false */
  w.lot = async ({ customer, quality, thaans, meters, pieces, unit, date = '2026-10-10', approve = true, ...rest }) => {
    customer = customer || (w._cu ||= await w.customer());
    quality = quality || (w._q ||= await w.quality());
    const body = { inwardDate: date, customerId: customer.id, qualityId: quality.id, ...rest };
    if (unit) body.unit = unit;
    if (thaans) body.thaans = thaans;
    else { body[unit === 'YARD' ? 'inwardYards' : 'inwardMeters'] = meters; body.pieces = pieces || 1; }
    const lot = await w.ok('post', '/grey-lots', body, 201);
    if (approve) await w.ok('post', `/grey-lots/${lot.id}/approve`);
    return lot;
  };
  /** an SO card: lots [{ greyLotId, thaanNos | thaans | meters }] */
  w.card = (lots, extra = {}) => w.ok('post', '/so-cards', { cardDate: '2026-10-11', lots, ...extra }, 201);
  /** every SO desk row waiting to be sent, newest card first */
  w.deskRows = async () => (await w.ok('get', '/jobs/form-data')).rows;
  /** send an SO card (or some of its lines) from the SO desk to a department as a job */
  w.sendCard = async (card, deptCode, { meters } = {}) => {
    const rows = (await w.deskRows()).filter((r) => r.soCard.id === card.id);
    const items = rows.map((r) => ({ soCardLotId: r.soCardLotId, ...(meters !== undefined && { meters }) }));
    return w.ok('post', '/jobs', { departmentId: w.s[deptCode].id, items }, 201);
  };
  /** Receive + Accept in the department (status PENDING) */
  w.accept = async (deptCode, job) => {
    await w.ok('post', `/departments/${deptCode}/jobs/${job.id}/receive`);
    return w.ok('post', `/departments/${deptCode}/jobs/${job.id}/accept`);
  };
  w.status = (deptCode, job, status, reason) => w.ok('put', `/departments/${deptCode}/jobs/${job.id}/status`, { status, reason });
  /** operator + process date, then COMPLETE (the cloth can go on) */
  w.complete = async (deptCode, job) => {
    await w.ok('put', `/departments/${deptCode}/jobs/${job.id}/operator`, { operatorName: 'Operator', processDate: '2026-10-18' });
    return w.status(deptCode, job, 'COMPLETE');
  };
  /** send the whole COMPLETE job on to another department; returns the new job */
  w.forward = async (fromCode, job, toCode) => {
    const form = await w.ok('get', `/departments/${fromCode}/send-form`);
    const rows = form.rows.filter((r) => r.job.id === job.id);
    return w.ok('post', `/departments/${fromCode}/send`, { toDepartmentCode: toCode, items: rows.map((r) => ({ jobItemId: r.jobItemId })) }, 201);
  };

  // ---- store and chemicals ----
  w.vendor = (name = 'ALI CHEM') => w.ok('post', '/vendors', { name });
  w.chem = (name, unit = 'KG') => w.ok('post', '/stores/chemical/items', { name, unit });
  /** an approved purchase of one chemical: qty at rate */
  w.buy = (item, qty, rate, date = '2026-10-12') => w.ok('post', '/stores/chemical/inwards', { inwardDate: date, vendorName: 'ALI CHEM', lines: [{ itemId: item.id, qty, rate }], approve: true }, 201);
  w.give = (deptCode, items) => w.ok('put', `/stores/chemical/department-access/${deptCode}`, { add: items.map((i) => i.id) });
  /** the department asks, the store accepts and sends (batches optional), the department receives; returns the sent request */
  w.issue = async (deptCode, job, lines, { soCardId, sendLines, receive = true } = {}) => {
    const r = await w.ok('post', `/departments/${deptCode}/chemical-requests`, { jobId: job.id, ...(soCardId && { soCardId }), lines }, 201);
    await w.ok('post', `/stores/chemical/requests/${r.id}/accept`);
    const sent = await w.ok('post', `/stores/chemical/requests/${r.id}/send`, sendLines ? { lines: sendLines(r) } : {});
    if (receive) await w.ok('post', `/departments/${deptCode}/chemical-requests/${r.id}/receive`);
    return sent;
  };
  w.stock = async (item) => (await w.ok('get', '/stores/chemical/stock')).data.find((i) => i.id === item.id);

  // ---- employees ----
  /** an employee of the company with these grants [[serviceCode, 'VIEW' | 'FULL']] */
  w.employee = async (grants) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    for (const [code, access] of grants) await UserService.create({ userId: u.id, serviceId: s[code] ? s[code].id : (await Service.findOne({ where: { code } })).id, access });
    return as({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` });
  };
  return w;
}

/** deterministic random numbers (the same seed always gives the same run) */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(next() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, pick, int };
}

module.exports = { world, rng, checkInvariants, expectClean, clean, request, app, makeUser, makeCompany, loginAs, sequelize, ALL_SERVICES };
