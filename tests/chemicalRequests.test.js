const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

test('department asks chemicals for a job; store accepts, sends (stock out at avg rate); department receives; cost per job and SO card', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'STORE_REPORTS', 'DYEING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);

  // two SO cards in one dyeing job: 6000 m + 4000 m
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ TEXTILES' })).body;
  const q = (await api('post', '/qualities', { name: '16X10 PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 10000, pieces: 10 })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const so1 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 6000 }] })).body;
  const so2 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 4000 }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;

  // stock: RED 10 kg at 100 = 1000
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI CHEM', lines: [{ itemId: red.id, qty: 10, rate: 100 }], approve: true });

  // chemical not given yet / job not accepted yet
  let r = await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qtyMain: 2, qtySub: 500 }] });
  expect(r.body.error.code).toBe('JOB_NOT_ACCEPTED');
  await api('put', `/jobs/${job.id}/status`, { status: 'PROCESSING' });
  r = await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qtyMain: 2, qtySub: 500 }] });
  expect(r.body.error.code).toBe('CHEMICAL_NOT_GIVEN');
  await api('put', '/stores/chemical/department-access/DYEING', { add: [red.id] });

  const form = (await api('get', '/departments/DYEING/chemical-requests/form-data')).body;
  expect(form.jobs[0].soCards.map((c) => c.cardNo)).toEqual([so1.cardNo, so2.cardNo]);
  expect(form.chemicals.map((c) => c.name)).toEqual(['RED']);

  // request 1: whole job, 2 kg 500 g; request 2: only SO card 2, 500 g
  const r1 = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qtyMain: 2, qtySub: 500 }] })).body;
  expect(r1).toMatchObject({ reqNo: 1, status: 'PENDING', departmentStatusText: 'Pending', storeStatusText: 'Queue', requestedBy: { id: admin.id } });
  expect(r1.lines[0].qtySplit.text).toBe('2 KG 500 G');
  expect((await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, soCardId: so1.id === so2.id ? null : '00000000-0000-4000-8000-000000000000', lines: [{ itemId: red.id, qty: 1 }] })).body.error.code).toBe('SO_NOT_IN_JOB');
  const r2 = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, soCardId: so2.id, lines: [{ itemId: red.id, qty: 1 }] })).body;
  expect((await api('patch', `/departments/DYEING/chemical-requests/${r2.id}`, { lines: [{ itemId: red.id, qtySub: 500 }] })).body.lines[0].qty).toBe(0.5);

  // store: queue -> process -> send
  let list = (await api('get', '/stores/chemical/requests?tab=queue')).body;
  expect(list).toMatchObject({ total: 2, counts: { queue: 2, process: 0 } });
  expect((await api('post', `/stores/chemical/requests/${r1.id}/send`)).body.error.code).toBe('NOT_ACCEPTED');
  const acc = (await api('post', `/stores/chemical/requests/${r1.id}/accept`)).body;
  expect(acc).toMatchObject({ status: 'ACCEPTED', departmentStatusText: 'Accepted', storeStatusText: 'Process', acceptedBy: { id: admin.id } });
  expect((await api('patch', `/departments/DYEING/chemical-requests/${r1.id}`, { notes: 'x' })).body.error.code).toBe('NOT_PENDING');
  expect((await api('post', `/stores/chemical/requests/${r1.id}/send`, { lines: [{ lineId: acc.lines[0].id, qtyMain: 20 }] })).body.error.code).toBe('NOT_ENOUGH_STOCK');
  const sent = (await api('post', `/stores/chemical/requests/${r1.id}/send`, { sentThrough: 'Akram' })).body;
  expect(sent).toMatchObject({ status: 'IN_WAY', storeStatusText: 'In-Way', totalValue: 250, sentThrough: 'Akram' });
  expect(sent.lines[0]).toMatchObject({ sentQty: 2.5, rate: 100, value: 250 });
  expect((await StoreItem.findByPk(red.id)).stockQty).toBe(7.5);
  const got = (await api('post', `/departments/DYEING/chemical-requests/${r1.id}/receive`)).body;
  expect(got).toMatchObject({ status: 'DELIVERED', departmentStatusText: 'Received', storeStatusText: 'Delivered', receivedBy: { id: admin.id } });

  await api('post', `/stores/chemical/requests/${r2.id}/accept`);
  await api('post', `/stores/chemical/requests/${r2.id}/send`);

  // cost: job 300; SO1 = 60% of 250 = 150; SO2 = 40% of 250 + 50 = 150
  const jc = (await api('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`)).body;
  expect(jc).toMatchObject({ totalValue: 300 });
  expect(jc.chemicals[0]).toMatchObject({ qty: 3, value: 300, qtySplit: { text: '3 KG' } });
  const c1 = (await api('get', `/stores/chemical/cost/so-cards/${so1.id}`)).body;
  const c2 = (await api('get', `/stores/chemical/cost/so-cards/${so2.id}`)).body;
  expect(c1.totalValue).toBe(150);
  expect(c1.chemicals[0].qtySplit.text).toBe('1 KG 500 G');
  expect(c2.totalValue).toBe(150);
  // department screens: SO card cost and the reports
  expect((await api('get', `/departments/DYEING/so-cards/${so1.id}/chemical-cost`)).body.totalValue).toBe(150);
  const rj = (await api('get', '/departments/DYEING/chemical-cost/jobs')).body;
  expect(rj).toMatchObject({ total: 1, totalValue: 300 });
  expect(rj.data[0]).toMatchObject({ job: { jobNo: job.jobNo }, value: 300, requests: 2, departments: ['Dyeing'], customers: ['AZ TEXTILES'] });
  const rs = (await api('get', '/stores/chemical/cost/so-cards?dateFrom=2000-01-01')).body;
  expect(rs).toMatchObject({ total: 2, totalValue: 300 });
  expect(rs.data.map((x) => x.value)).toEqual([150, 150]);
  expect((await api('get', '/stores/chemical/cost/jobs?dateTo=2000-01-01')).body.total).toBe(0);

  // department sends 500 g back from request 1 (it went out at 100 / kg)
  const rl = got.lines[0].id;
  expect(got.lines[0].returnableQty).toBe(2.5);
  expect((await api('post', '/departments/DYEING/chemical-returns', { requestId: r2.id, lines: [{ requestLineId: r2.lines[0].id, qty: 0.1 }] })).body.error.code).toBe('NOT_RECEIVED');
  expect((await api('post', '/departments/DYEING/chemical-returns', { requestId: r1.id, lines: [{ requestLineId: rl, qtyMain: 3 }] })).body.error.code).toBe('TOO_MUCH');
  const back = (await api('post', '/departments/DYEING/chemical-returns', { requestId: r1.id, lines: [{ requestLineId: rl, qtySub: 500 }] })).body;
  expect(back).toMatchObject({ returnNo: 1, status: 'PENDING', departmentStatusText: 'Sent back', storeStatusText: 'To receive', totalValue: 50, job: { jobNo: job.jobNo } });
  expect((await api('post', '/departments/DYEING/chemical-returns', { requestId: r1.id, lines: [{ requestLineId: rl, qtyMain: 2, qtySub: 1 }] })).body.error.code).toBe('TOO_MUCH');
  expect((await api('get', '/stores/chemical/returns?tab=pending')).body.counts).toMatchObject({ pending: 1 });
  const before = (await StoreItem.findByPk(red.id)).stockQty;
  const rec = (await api('post', `/stores/chemical/returns/${back.id}/receive`)).body;
  expect(rec).toMatchObject({ status: 'RECEIVED', storeStatusText: 'Received', receivedBy: { id: admin.id } });
  expect((await StoreItem.findByPk(red.id)).stockQty).toBe(before + 0.5);
  expect((await api('get', `/departments/DYEING/jobs/${job.id}/chemical-cost`)).body.totalValue).toBe(250);
  expect((await api('get', `/stores/chemical/cost/so-cards/${so1.id}`)).body.totalValue).toBe(120);
  const r1now = (await api('get', `/departments/DYEING/chemical-requests/${r1.id}`)).body;
  expect(r1now).toMatchObject({ returnedValue: 50, netValue: 200 });
  expect(r1now.lines[0]).toMatchObject({ returnedSplit: { text: '500 G' }, returnableQty: 2 });
  const moves = (await api('get', `/stores/chemical/items/${red.id}/moves`)).body.data.map((x) => x.kind);
  // job list columns: chemicals of each job / SO card
  const jl = (await api('get', '/departments/DYEING/incoming')).body.data[0];
  expect(jl).toMatchObject({ chemicalCount: 1, chemicalAmount: 250, costPerMeter: 0.025, chemicalRequests: 2, pendingChemicalRequests: 0 });
  const sl = (await api('get', '/departments/DYEING/incoming?view=so')).body.data;
  expect(sl.map((x) => [x.soCard.cardNo, x.chemicalCount, x.chemicalAmount, x.costPerMeter])).toEqual([[so1.cardNo, 1, 120, 0.02], [so2.cardNo, 1, 130, 0.0325]]);
  expect(moves).toEqual(['INWARD', 'ISSUE', 'ISSUE', 'RETURN']);

  // reject with reason; cancel own pending
  const r3 = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 1 }] })).body;
  expect((await api('post', `/stores/chemical/requests/${r3.id}/reject`, { reason: 'Stock short' })).body).toMatchObject({ status: 'REJECTED', rejectReason: 'Stock short' });
  const r4 = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 1 }] })).body;
  expect((await api('post', `/departments/DYEING/chemical-requests/${r4.id}/cancel`)).body.status).toBe('CANCELLED');
  list = (await api('get', '/departments/DYEING/chemical-requests')).body;
  expect(list.counts).toMatchObject({ pending: 0, in_way: 1, received: 1, closed: 2 });
  expect((await api('get', `/departments/DYEING/chemical-requests?soNo=${so1.cardNo}`)).body.total).toBe(4);

  // VIEW user on dyeing cannot create
  const user = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: user.id, serviceId: s.DYEING.id, access: 'VIEW' });
  const ua = { Authorization: `Bearer ${(await loginAs(user)).accessToken}` };
  expect((await request(app).get('/api/v1/departments/DYEING/chemical-requests').set(ua)).status).toBe(200);
  expect((await request(app).post('/api/v1/departments/DYEING/chemical-requests').set(ua).send({ jobId: job.id, lines: [{ itemId: red.id, qty: 1 }] })).status).toBe(403);
  expect((await request(app).get('/api/v1/stores/chemical/requests').set(ua)).status).toBe(403);
});

test('chemical not in stock: department can still ask; store offers an alternate or a date', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'STORE_REPORTS', 'DYEING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { code: 1, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 1000, pieces: 1 })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 1000 }] });
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  await api('put', `/jobs/${job.id}/status`, { status: 'PROCESSING' });
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  const blue = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'BLUE RCL' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI', lines: [{ itemId: blue.id, qty: 5, rate: 200 }], approve: true });
  await api('put', '/stores/chemical/department-access/DYEING', { add: [red.id, blue.id] });
  expect((await api('get', '/departments/DYEING/chemical-requests/form-data')).body.chemicals.find((c) => c.name === 'RED').inStock).toBe(false);

  // RED is 0 in stock: request still goes
  let r = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qtyMain: 2 }] })).body;
  expect(r).toMatchObject({ status: 'PENDING', shortCount: 1 });
  expect(r.lines[0]).toMatchObject({ inStock: false, shortSplit: { text: '2 KG' } });
  const sh = (await api('get', '/stores/chemical/requests/shortages')).body;
  expect(sh.data[0]).toMatchObject({ item: { name: 'RED' }, demandSplit: { text: '2 KG' }, shortSplit: { text: '2 KG' } });

  // store: when it will come
  const line = r.lines[0].id;
  r = (await api('post', `/stores/chemical/requests/${r.id}/lines/${line}/eta`, { etaDate: '2026-10-20', note: 'Vendor se aa raha hai' })).body;
  expect(r.lines[0].eta).toMatchObject({ date: '2026-10-20', by: { id: admin.id } });

  // store: alternate BLUE 1 kg 500 g; send is blocked until department answers
  await api('post', `/stores/chemical/requests/${r.id}/accept`);
  r = (await api('post', `/stores/chemical/requests/${r.id}/lines/${line}/alternate`, { itemId: blue.id, qtyMain: 1, qtySub: 500, note: 'Same shade' })).body;
  expect(r).toMatchObject({ waitingForDepartment: true });
  expect(r.lines[0].alternate).toMatchObject({ status: 'OFFERED', item: { name: 'BLUE RCL' }, qtySplit: { text: '1 KG 500 G' } });
  expect((await api('post', `/stores/chemical/requests/${r.id}/send`)).body.error.code).toBe('WAITING_DEPARTMENT');

  // department says no -> stays RED; store offers again; department says yes -> line is BLUE
  r = (await api('post', `/departments/DYEING/chemical-requests/${r.id}/lines/${line}/alternate`, { accept: false })).body;
  expect(r.lines[0]).toMatchObject({ item: { name: 'RED' }, alternate: { status: 'DECLINED' } });
  await api('post', `/stores/chemical/requests/${r.id}/lines/${line}/alternate`, { itemId: blue.id, qtyMain: 1, qtySub: 500 });
  r = (await api('post', `/departments/DYEING/chemical-requests/${r.id}/lines/${line}/alternate`, { accept: true })).body;
  expect(r.lines[0]).toMatchObject({ item: { name: 'BLUE RCL' }, originalItem: { name: 'RED' }, qty: 1.5, inStock: true, eta: null, alternate: { status: 'ACCEPTED', decidedBy: { id: admin.id } } });
  const sent = (await api('post', `/stores/chemical/requests/${r.id}/send`)).body;
  expect(sent).toMatchObject({ status: 'IN_WAY', totalValue: 300 });
  expect((await api('get', '/stores/chemical/requests/shortages')).body.total).toBe(0);
});

test('stock adjustment: count, damaged, add; with reason and history', async () => {
  const company = await makeCompany();
  const cs = await Service.findOne({ where: { code: 'CHEMICAL_STORE' } });
  await CompanyService.create({ companyId: company.id, serviceId: cs.id });
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI', lines: [{ itemId: red.id, qty: 10, rate: 100 }], approve: true });

  // counted 9 kg 750 g
  let a = (await api('post', '/stores/chemical/adjustments', { reason: 'COUNT', adjDate: '2026-10-17', lines: [{ itemId: red.id, mode: 'COUNT', qtyMain: 9, qtySub: 750 }] })).body;
  expect(a).toMatchObject({ adjNo: 1, reasonText: 'Stock count', totalValue: -25 });
  expect(a.lines[0]).toMatchObject({ direction: 'OUT', qtySplit: { text: '250 G' }, stockBeforeSplit: { text: '10 KG' }, stockAfterSplit: { text: '9 KG 750 G' } });
  expect((await api('post', '/stores/chemical/adjustments', { reason: 'COUNT', lines: [{ itemId: red.id, mode: 'COUNT', qtyMain: 9, qtySub: 750 }] })).body.error.code).toBe('NO_CHANGE');
  expect((await api('post', '/stores/chemical/adjustments', { reason: 'DAMAGED', lines: [{ itemId: red.id, mode: 'OUT', qtyMain: 20 }] })).body.error.code).toBe('NOT_ENOUGH_STOCK');
  a = (await api('post', '/stores/chemical/adjustments', { reason: 'DAMAGED', notes: 'Bag phat gaya', lines: [{ itemId: red.id, mode: 'OUT', qtyMain: 1, qtySub: 750 }] })).body;
  expect(a).toMatchObject({ adjNo: 2, totalValue: -175 });
  a = (await api('post', '/stores/chemical/adjustments', { reason: 'OTHER', lines: [{ itemId: red.id, mode: 'IN', qty: 2, rate: 100 }] })).body;
  const item = await StoreItem.findByPk(red.id);
  expect([item.stockQty, item.stockValue]).toEqual([10, 1000]);
  const list = (await api('get', `/stores/chemical/adjustments?itemId=${red.id}&reason=DAMAGED`)).body;
  expect(list.total).toBe(1);
  const moves = (await api('get', `/stores/chemical/items/${red.id}/moves`)).body.data;
  expect(moves.map((x) => x.kindText)).toEqual(['Purchase', 'Stock adjustment', 'Stock adjustment', 'Stock adjustment']);
});
