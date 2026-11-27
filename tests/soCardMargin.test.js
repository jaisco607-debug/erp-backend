const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService } = require('../src/models');
const { today } = require('../src/utils/dates');

jest.setTimeout(240000);
beforeEach(clean);

// owner plan N-C1: SO card cost and margin: each cost part on its own ("not entered" is not zero), revenue from the invoice or the packed value, margin in money and percent
const SERVICES = ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING', 'PACKING', 'ACC_COA', 'ACC_SALES', 'ACC_REPORTS'];
async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of SERVICES) { s[code] = await Service.findOne({ where: { code } }); await CompanyService.create({ companyId: company.id, serviceId: s[code].id }); }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const production = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: production.id, serviceId: s.SO_CARD.id, access: 'FULL' });
  const as = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
  return { company, s, api: as(admin), productionApi: as(production) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };

/** The whole road of one SO card (360 m) up to two final packing lists with gate passes: list 1 = 8,000, list 2 = 3,200. */
async function road(w) {
  const api = w.api;
  const cu = await ok(api('post', '/customers', { name: 'AZ TEXTILES', ntn: '2123864-2', city: 'Karachi' }), 201);
  const q = await ok(api('post', '/qualities', { name: 'PC TWILL' }), 201);
  const lot = await ok(api('post', '/grey-lots', { inwardDate: today(), customerId: cu.id, qualityId: q.id, thaans: [100, 120, 80, 60] }), 201);
  await ok(api('post', `/grey-lots/${lot.id}/approve`));
  const card = await ok(api('post', '/so-cards', { cardDate: today(), lots: [{ greyLotId: lot.id, thaanNos: [1, 2, 3, 4] }] }), 201);
  const fd = await ok(api('get', '/jobs/form-data'));
  const dye = await ok(api('post', '/jobs', { departmentId: w.s.DYEING.id, items: [{ soCardLotId: fd.rows.find((r) => r.soCard.id === card.id).soCardLotId }] }), 201);
  await ok(api('put', `/departments/DYEING/jobs/${dye.id}/status`, { status: 'COMPLETE' }));
  await ok(api('put', `/departments/DYEING/jobs/${dye.id}/operator`, { operatorName: 'Aslam', processDate: today() }));
  const form = await ok(api('get', '/departments/DYEING/send-form'));
  const fold = await ok(api('post', '/departments/DYEING/send', { toDepartmentCode: 'FOLDING', items: [{ jobItemId: form.rows.find((r) => r.soCard.id === card.id).jobItemId }] }), 201);
  await ok(api('post', `/departments/FOLDING/jobs/${fold.id}/accept`));
  const frow = await ok(api('get', `/departments/FOLDING/folding/${fold.id}/${card.id}`));
  const ls = frow.lots[0].lines;
  await ok(api('put', `/departments/FOLDING/folding/${fold.id}/${card.id}/grades`, { lines: [
    { greyLotId: lot.id, thaanId: ls[0].thaanId, a: 100 }, { greyLotId: lot.id, thaanId: ls[1].thaanId, b: 120 }, { greyLotId: lot.id, thaanId: ls[2].thaanId, a: 80 }, { greyLotId: lot.id, thaanId: ls[3].thaanId, b: 60 },
  ] }));
  const pack = (await ok(api('post', `/departments/FOLDING/folding/${fold.id}/${card.id}/send-packing`, { keepRemaining: false }), 201)).packingJob;
  await ok(api('post', `/departments/PACKING/jobs/${pack.id}/accept`));
  const f = await ok(api('get', `/departments/PACKING/packing/so-cards/${card.id}/form`));
  const [t1, t2, t3, t4] = f.lots[0].thaans;
  const line = (t, grade, meters) => ({ greyLotId: lot.id, thaanId: t.thaanId, grade, meters });
  const finish = async (body, destination) => {
    const pl = (await ok(api('post', '/departments/PACKING/packing-lists', { soCardId: card.id, ...body }), 201));
    await ok(api('post', `/departments/PACKING/packing-lists/${pl.id}/final`));
    return ok(api('put', `/departments/PACKING/packing-lists/${pl.id}/gate-pass`, { destination, vehicleNo: 'LEA-1', passDate: today() }));
  };
  const gp1 = await finish({ rateA: 50, rateB: 25, lines: [line(t1, 'A', 100), line(t2, 'B', 120)] }, 'Lahore'); // 5,000 + 3,000 = 8,000
  await finish({ rateA: 40, lines: [line(t3, 'A', 80), line(t4, 'B', 60)] }, 'Karachi'); // 3,200
  return { cu, card, gp1 };
}

test('SO card margin: parts "not entered" are not zero; rates make the department and packing parts; revenue from the invoice or the packed value', async () => {
  const w = await setup();
  const { cu, card, gp1 } = await road(w);
  const rowOf = async (query = '') => (await ok(w.api('get', `/reports/so-card-margin${query}`))).sections[0].rows.find((r) => r.soNo === card.cardNo);

  // nothing is priced yet: revenue = the packed value of both lists (no invoice), the costs that exist are "not entered"
  let r = await rowOf();
  expect(r).toMatchObject({ meters: 360, revenue: 11200, revenueSource: 'PACKED', totalCost: 0, costComplete: false });
  expect(r.parts).toMatchObject({ grey: { status: 'NOT_APPLICABLE' }, chemicals: { amount: null, status: 'NOT_ENTERED' }, yarn: { status: 'NOT_APPLICABLE' },
    departmentCharges: { amount: null, status: 'NOT_ENTERED' }, packing: { amount: null, status: 'NOT_ENTERED' } });
  expect(r.chemicalCost).toBeNull(); // not entered is null, not 0
  expect(r.missingParts).toEqual(['chemicals', 'departmentCharges', 'packing']);

  // the rates of the departments (Settings > Process rates): Dyeing 2 / m, Folding 1 / m, Packing 0.5 / m
  const rates = await ok(w.api('get', '/process-rates'));
  const dep = (code) => rates.departments.find((d) => d.code === code);
  expect(rates.departments.map((d) => d.code).sort()).toEqual(['DYEING', 'FOLDING', 'PACKING']);
  await ok(w.api('put', '/process-rates', { departmentId: dep('DYEING').id, ratePerMeter: 2, effectiveFrom: '2026-01-01' }));
  await ok(w.api('put', '/process-rates', { departmentId: dep('PACKING').id, ratePerMeter: 0.5, effectiveFrom: '2026-01-01' }));
  r = await rowOf();
  // Folding has no rate yet: the department part is only PARTLY there
  expect(r.parts.departmentCharges).toMatchObject({ amount: 720, status: 'PARTLY', missing: ['Folding'] });
  expect(r.parts.packing).toMatchObject({ amount: 180, status: 'ENTERED' });
  await ok(w.api('put', '/process-rates', { departmentId: dep('FOLDING').id, ratePerMeter: 1, effectiveFrom: '2026-01-01' }));
  r = await rowOf();
  expect(r.parts.departmentCharges).toMatchObject({ amount: 1080, status: 'ENTERED' });
  expect(r).toMatchObject({ departmentCost: 1080, packingCost: 180, totalCost: 1260, costPerMeter: 3.5, margin: 9940, marginPercent: 88.75, costStatus: 'Cost not complete', missingParts: ['chemicals'] });

  // the invoice of the first list (8,000 before tax) replaces its packed value
  const inv = await ok(w.api('post', '/sales-invoices', { customerId: cu.id, invoiceDate: today(), gatePassIds: [gp1.id] }), 201);
  r = await rowOf();
  expect(r.revenueSource).toBe('PACKED'); // a draft invoice is not revenue yet
  await ok(w.api('post', `/sales-invoices/${inv.id}/approve`));
  r = await rowOf();
  expect(r).toMatchObject({ revenue: 11200, revenueSource: 'MIXED', margin: 9940 });

  // the detail of one card: the parts behind the numbers
  const d = await ok(w.api('get', `/reports/so-card-margin/${card.id}`));
  expect(d.detail.jobs.map((j) => [j.department, j.meters, j.ratePerMeter, j.charge])).toEqual([['Dyeing', 360, 2, 720], ['Folding', 360, 1, 360], ['Packing', 360, 0.5, 180]]);
  expect(d.detail.packingLists.map((l) => [l.source, l.amount, l.packedValue])).toEqual([['INVOICE', 8000, 8000], ['PACKED', 3200, 3200]]);
  expect(d.partsText.departmentCharges).toBe('Department charges');

  // the list totals and the filters
  const all = await ok(w.api('get', '/reports/so-card-margin'));
  expect(all.sections[0].totals).toMatchObject({ revenue: 11200, totalCost: 1260, margin: 9940, incompleteCards: 1 });
  expect((await ok(w.api('get', `/reports/so-card-margin?customerId=${cu.id}&soNo=${card.cardNo}`))).sections[0].rows).toHaveLength(1);
  expect((await ok(w.api('get', '/reports/so-card-margin?soNo=9999'))).sections[0].rows).toHaveLength(0);
  expect((await ok(w.api('get', '/reports'))).reports.map((x) => x.key)).toContain('so-card-margin');
});

test('SO card margin: only accounting sees it; rates are for the accounting service; another company sees nothing; the rate of the day of the job is used', async () => {
  const w = await setup();
  const other = await setup();
  const { card } = await road(w);
  // production people (SO card service) cannot open the margin or the rates
  await fails(w.productionApi('get', '/reports/so-card-margin'), 403, 'FORBIDDEN');
  await fails(w.productionApi('get', `/reports/so-card-margin/${card.id}`), 403, 'FORBIDDEN');
  expect((await w.productionApi('get', '/process-rates')).status).toBe(403);
  // another company: no cards, no detail
  expect((await ok(other.api('get', '/reports/so-card-margin'))).sections[0].rows).toHaveLength(0);
  await fails(other.api('get', `/reports/so-card-margin/${card.id}`), 404, 'NOT_FOUND');
  // a rate from a day after the jobs does not count; the earlier one does
  const dye = (await ok(w.api('get', '/process-rates'))).departments.find((d) => d.code === 'DYEING');
  await ok(w.api('put', '/process-rates', { departmentId: dye.id, ratePerMeter: 3, effectiveFrom: '2026-01-01' }));
  const later = new Date(`${today()}T00:00:00Z`); later.setUTCDate(later.getUTCDate() + 20);
  const after = await ok(w.api('put', '/process-rates', { departmentId: dye.id, ratePerMeter: 9, effectiveFrom: later.toISOString().slice(0, 10) }));
  expect(after.departments.find((d) => d.code === 'DYEING')).toMatchObject({ currentRate: 3 });
  const detail = await ok(w.api('get', `/reports/so-card-margin/${card.id}`));
  expect(detail.detail.jobs.find((j) => j.department === 'Dyeing')).toMatchObject({ ratePerMeter: 3, charge: 1080 });
  // a rate can be removed; unknown departments and negative rates are refused
  const gone = await ok(w.api('delete', `/process-rates/${after.departments.find((d) => d.code === 'DYEING').rates[0].id}`));
  expect(gone.departments.find((d) => d.code === 'DYEING').rates).toHaveLength(1);
  const finishing = await Service.findOne({ where: { code: 'FINISHING' } }); // a department this company does not have
  await fails(w.api('put', '/process-rates', { departmentId: finishing.id, ratePerMeter: 1, effectiveFrom: '2026-01-01' }), 404, 'NOT_FOUND');
  await fails(w.api('put', '/process-rates', { departmentId: dye.id, ratePerMeter: -1, effectiveFrom: '2026-01-01' }), 400, 'VALIDATION_FAILED');
});
