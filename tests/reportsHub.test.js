const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, sequelize } = require('../src/models');

beforeEach(clean);

const URLS = ['overview', 'grey/parties', 'grey/lots', 'grey/returns', 'so-cards', 'so-cards/lots', 'departments', 'departments/jobs', 'departments/operators',
  'chemical-cost', 'ledger', 'daily-stock', 'quality-wise', 'party-cost', 'grade-summary', 'grade-summary?by=quality', 'ageing', 'pending-jobs', 'delivery-due', 'rework-jobs', 'departments-daily', 'ledgers/lot', 'ledgers/party', 'ledgers/so-card', 'ledgers/department', 'ledgers/operator', 'ledgers/cost', 'audit-check', 'folding', 'active-fabric', 'packing-lists', 'packing-lists/lines', 'gate-passes'];

test('reports hub: index, overview and all 15 urls answer, also for a report-only user', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING', 'FOLDING', 'PACKING', 'REPORT_OVERVIEW', 'REPORT_GREY', 'REPORT_SO_CARDS', 'REPORT_DEPARTMENTS', 'REPORT_CHEMICAL_COST',
    'REPORT_FOLDING', 'REPORT_ACTIVE_FABRIC', 'REPORT_PACKING', 'REPORT_GATE_PASSES']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [100, 100, 100, 100] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const so = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  await api('post', `/grey-lots/${lot.id}/give-back`, { returnDate: '2026-10-12', thaanNos: [4], vehicleNo: 'LEA-1' });

  const idx = await api('get', '/reports');
  expect(idx.status).toBe(200);
  expect(idx.body.reports.map((r) => r.url)).toEqual(expect.arrayContaining(URLS.filter((u) => !u.includes('?')).map((u) => `/v1/reports/${u}`)));
  expect(idx.body.customers[0]).toMatchObject({ id: cu.id, name: 'AZ', code: 130 });
  expect(idx.body.qualities[0]).toMatchObject({ id: q.id, name: 'PC TWILL' });
  expect(idx.body.departments.map((d) => d.name)).toContain('Dyeing');
  expect(idx.body.soCardStatuses[0]).toEqual({ value: 'NOT_SENT', text: 'Not sent' });
  expect(idx.body.jobStatuses.map((j) => j.value)).toContain('PROCESSING');

  for (const u of URLS) {
    const r = await api('get', `/reports/${u}${u.includes('?') ? '&' : '?'}page=1&limit=30&dateFrom=&customerId=&search=`);
    expect([u, r.status]).toEqual([u, 200]);
    expect(Array.isArray(r.body.sections)).toBe(true);
    const all = await api('get', `/reports/${u}${u.includes('?') ? '&' : '?'}all=true`);
    expect([u, all.status]).toEqual([u, 200]);
  }
  let r = (await api('get', '/reports/overview')).body;
  expect(r.sections[0].rows.find((x) => x.metric === 'Grey received')).toMatchObject({ value: 400 });
  expect(r.sections[0].rows.find((x) => x.metric === 'SO cards')).toMatchObject({ value: 1 });
  const tbl = r.sections[2].rows;
  expect(tbl.reduce((t, x) => t + x.cards, 0)).toBe(r.sections[0].rows.find((x) => x.metric === 'SO cards').value);
  expect(tbl.find((x) => x.statusText === 'Not sent').cards).toBe(r.sections[0].rows.find((x) => x.metric === 'SO cards: not sent').value);
  expect(tbl.find((x) => x.statusText === 'Not sent').cards).toBe(1);
  expect((await api('get', '/reports/so-cards?status=NOT_SENT')).body.sections[0].rows).toHaveLength(1);
  expect((await api('get', '/reports/so-cards?status=IN_DEPARTMENT')).body.sections[0].rows).toHaveLength(0);
  r = (await api('get', '/reports/grey/returns')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ party: 'AZ', meters: 100, vehicleNo: 'LEA-1' });
  r = (await api('get', `/reports/so-cards/lots?customerId=${cu.id}&qualityId=${q.id}`)).body;
  expect(r.sections[0].rows[0]).toMatchObject({ soNo: so.cardNo, thaans: 2, meters: 200, thaanNos: '1, 2' });
  r = (await api('get', `/reports/so-cards?search=AZ&qualityId=${q.id}`)).body;
  expect(r.sections[0].rows[0]).toMatchObject({ soCardId: so.id, soNo: so.cardNo });
  expect((await api('get', `/reports/so-cards/${so.id}`)).status).toBe(200);
  expect((await api('get', '/reports/grey/lots?stock=in_store')).body.sections[0].rows).toHaveLength(1);

  r = (await api('get', `/reports/ledger?customerId=${cu.id}`)).body;
  expect(r.sections[0].rows.map((x) => [x.type, x.balance])).toEqual([['Grey in', 400], ['SO card', 200], ['Grey given back', 100]]);
  r = (await api('get', '/reports/ledger?dateFrom=2026-10-11')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ type: 'Opening balance', balance: 400 });
  expect((await api('get', `/reports/ledger?soNo=${so.cardNo}`)).body.sections[0].rows).toHaveLength(1);
  r = (await api('get', '/reports/daily-stock')).body;
  expect(r.sections[0].rows.map((x) => [x.date, x.opening, x.closing])).toEqual([['2026-10-12', 200, 100], ['2026-10-11', 400, 200], ['2026-10-10', 0, 400]]);

  // ledgers: running balances and the audit check
  r = (await api('get', `/reports/ledgers/lot?search=${lot.lotNo}`)).body;
  expect(r.sections[0].rows.map((x) => [x.type, x.balance])).toEqual([['Grey in', 400], ['SO card', 200], ['Grey given back', 100]]);
  r = (await api('get', `/reports/ledgers/so-card?soNo=${so.cardNo}`)).body;
  expect(r.sections[0].rows.map((x) => [x.type, x.balance])).toEqual([['Cloth taken', 200]]);
  r = (await api('get', '/reports/ledgers/party?dateFrom=2026-10-11')).body;
  expect(r.sections[0].rows[0]).toMatchObject({ type: 'Opening balance', balance: 400 });
  r = (await api('get', '/reports/audit-check')).body;
  expect(r.summary).toMatchObject({ check: 0 });
  await sequelize.query('UPDATE grey_lots SET "outwardMeters" = "outwardMeters" + 5 WHERE id = :id', { replacements: { id: lot.id } });
  r = (await api('get', '/reports/audit-check?status=check')).body;
  expect(r.sections[0].rows).toHaveLength(1);
  expect(r.sections[0].rows[0]).toMatchObject({ what: 'Grey lot', difference: 5, status: 'CHECK' });
  await sequelize.query('UPDATE grey_lots SET "outwardMeters" = "outwardMeters" - 5 WHERE id = :id', { replacements: { id: lot.id } });

  // a person with ONLY a report service (no Grey Store / SO Card service) can open that report and nothing else
  const rep = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: rep.id, serviceId: s.REPORT_GREY.id, access: 'VIEW' });
  const ra = { Authorization: `Bearer ${(await loginAs(rep)).accessToken}` };
  const get = (u) => request(app).get(`/api/v1${u}`).set(ra);
  expect((await get('/reports/grey/lots')).status).toBe(200);
  expect((await get('/reports/grey/returns')).status).toBe(200);
  expect((await get('/reports/gate-passes')).status).toBe(403);
  expect((await get('/reports/overview')).status).toBe(403);
  const ri = (await get('/reports')).body;
  expect(ri.reports.map((x) => x.key)).toEqual(['grey-parties', 'grey-lots', 'grey-returns', 'ledger', 'daily-stock', 'ledger-lot', 'ledger-party']);
  // a user with nothing sees no menu
  const none = await makeUser({ userType: 'USER', companyId: company.id });
  expect((await request(app).get('/api/v1/reports').set({ Authorization: `Bearer ${(await loginAs(none)).accessToken}` })).status).toBe(403);
});
