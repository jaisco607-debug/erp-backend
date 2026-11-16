const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, StoreYarnInward } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['YARN_STORE', 'CHEMICAL_STORE', 'STORE_REPORTS', 'GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const person = async (code, access) => {
    const u = await makeUser({ userType: 'USER', companyId: company.id });
    await UserService.create({ userId: u.id, serviceId: s[code].id, access });
    return call(u);
  };
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ TEXTILES' })).body;
  const q = (await api('post', '/qualities', { name: '16X10 PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 10000, pieces: 10 })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const so1 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 6000 }] })).body;
  const so2 = (await api('post', '/so-cards', { cardDate: '2026-10-11', lots: [{ greyLotId: lot.id, meters: 4000 }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: fd.rows.map((r) => ({ soCardLotId: r.soCardLotId })) })).body;
  const vendor = (await api('post', '/vendors', { name: 'Yarn Mills' })).body;
  const mk = async (extra) => {
    const e = (await api('post', '/store-yarn-inwards', { inwardDate: '2026-10-12', vendorId: vendor.id, yarnName: '22/s Cotton', brand: 'Crescent', bags: 10, lbsPerBag: 50, ratePerLb: 300, ...extra })).body;
    await api('post', `/store-yarn-inwards/${e.id}/approve`);
    return e;
  };
  return { company, s, api, person, so1, so2, job, vendor, mk };
}

test('the client admin switches yarn requests on for chosen departments only; the others cannot ask', async () => {
  const w = await setup();
  const st = (await w.api('get', '/department-settings')).body;
  expect(st.yarnStore).toBe(true);
  expect(st.data.map((d) => [d.code, d.yarnRequests, d.yarnEnabled, d.chemicalRequests, d.yarnRequestCount]).sort()).toEqual([['DYEING', false, false, true, 0], ['FOLDING', false, false, true, 0]]);
  err(await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, lines: [{ yarnName: 'x', bags: 1 }] }), 403, 'YARN_NOT_ALLOWED');
  err(await w.api('get', '/departments/DYEING/yarn-requests/form-data'), 403, 'YARN_NOT_ALLOWED');
  // switch Dyeing on; Folding stays off; the chemical switch is untouched
  const on = (await w.api('patch', '/department-settings/DYEING', { yarnRequests: true })).body;
  expect(on.data.find((d) => d.code === 'DYEING')).toMatchObject({ yarnRequests: true, yarnEnabled: true, chemicalRequests: true });
  expect(on.data.find((d) => d.code === 'FOLDING')).toMatchObject({ yarnRequests: false, yarnEnabled: false });
  expect((await w.api('get', '/departments/DYEING/yarn-requests/form-data')).status).toBe(200);
  err(await w.api('get', '/departments/FOLDING/yarn-requests'), 403, 'YARN_NOT_ALLOWED');
  // both switches in one call; nothing to change is refused
  const both = await w.api('put', '/department-settings', { departments: [{ code: 'FOLDING', yarnRequests: true, chemicalRequests: false }] });
  expect(both.body.data.find((d) => d.code === 'FOLDING')).toMatchObject({ yarnRequests: true, chemicalRequests: false });
  expect((await w.api('patch', '/department-settings/FOLDING', {})).status).toBe(400);
  expect((await w.api('put', '/department-settings', { departments: [{ code: 'FOLDING', yarnRequests: false }] })).body.data.find((d) => d.code === 'FOLDING').yarnRequests).toBe(false);
  // the login / me answer tells the department menu
  const me = (await w.api('get', '/auth/me')).body;
  const mine = (me.services || (me.user && me.user.services) || []).find((x) => x.code === 'DYEING');
  expect(mine).toMatchObject({ yarnRequests: true });
  // a company without the Yarn Store cannot switch
  await CompanyService.destroy({ where: { companyId: w.company.id, serviceId: w.s.YARN_STORE.id } });
  err(await w.api('patch', '/department-settings/DYEING', { yarnRequests: false }), 422, 'NO_YARN_STORE');
});

test('yarn request: department asks, store accepts and sends (bags from the oldest entries), department receives; stock, outward, ledger and the Job / SO card cost follow', async () => {
  const w = await setup();
  await w.api('patch', '/department-settings/DYEING', { yarnRequests: true });
  const a = await w.mk({}); // 10 bags x 50 lbs @ 300
  const a2 = await w.mk({ inwardDate: '2026-10-20', bags: 5, lbsPerBag: 100, ratePerLb: 310 }); // the same yarn, later
  const b = await w.mk({ yarnName: '30/s Polyester', brand: undefined, bags: 5, lbsPerBag: 100, ratePerLb: undefined });
  const body = (extra = {}) => ({ jobId: w.job.id, lines: [{ yarnName: '22/s Cotton', brand: 'Crescent', bags: 12 }, { yarnName: '30/s Polyester', bags: 3 }], ...extra });

  // the job must be accepted; the SO card must be in the job
  err(await w.api('post', '/departments/DYEING/yarn-requests', body()), 422, 'JOB_NOT_ACCEPTED');
  await w.api('put', `/jobs/${w.job.id}/status`, { status: 'PROCESSING' });
  const fd = (await w.api('get', '/departments/DYEING/yarn-requests/form-data')).body;
  expect(fd.nextReqNo).toBe(1);
  expect(fd.jobs.map((j) => [j.jobNo, j.soCards.map((c) => c.cardNo)])).toEqual([[w.job.jobNo, [w.so1.cardNo, w.so2.cardNo]]]);
  expect(fd.yarn.map((y) => [y.title, y.availableBags])).toEqual([['22/s Cotton - Crescent', 15], ['30/s Polyester', 5]]);
  err(await w.api('post', '/departments/DYEING/yarn-requests', body({ soCardId: '11111111-1111-4111-8111-111111111111' })), 422, 'SO_NOT_IN_JOB');
  err(await w.api('post', '/departments/DYEING/yarn-requests', body({ jobId: '11111111-1111-4111-8111-111111111111' })), 422, 'UNKNOWN_JOB');
  err(await w.api('post', '/departments/DYEING/yarn-requests', body({ lines: [{ yarnName: 'A', bags: 1 }, { yarnName: ' a ', bags: 2 }] })), 422, 'DUPLICATE_YARN');
  expect((await w.api('post', '/departments/DYEING/yarn-requests', body({ lines: [{ yarnName: 'A', bags: 0 }] }))).status).toBe(400);

  // request 1 for SO card 2; edit while pending
  const r1 = await w.api('post', '/departments/DYEING/yarn-requests', body({ soCardId: w.so2.id, notes: 'urgent' }));
  expect(r1.status).toBe(201);
  expect(r1.body).toMatchObject({ reqNo: 1, reqText: '00001', status: 'PENDING', departmentStatusText: 'Pending', storeStatusText: 'Queue', totalBags: 15, sentBags: 0, notes: 'urgent', soCard: { cardNo: w.so2.cardNo }, requestedBy: expect.any(Object) });
  expect(r1.body.lines.map((l) => [l.title, l.bags, l.sentBags])).toEqual([['22/s Cotton - Crescent', 12, null], ['30/s Polyester', 3, null]]);
  expect(r1.body.soCards.map((c) => c.cardNo)).toEqual([w.so1.cardNo, w.so2.cardNo]);
  const ed = await w.api('patch', `/departments/DYEING/yarn-requests/${r1.body.id}`, { notes: 'very urgent' });
  expect([ed.status, ed.body.notes, ed.body.lines.length]).toEqual([200, 'very urgent', 2]);

  // the store: queue -> accept -> send
  const q = (await w.api('get', '/store-yarn-outwards/requests?tab=queue')).body;
  expect([q.total, q.counts]).toEqual([1, { queue: 1, process: 0, in_way: 0, delivered: 0, closed: 0 }]);
  err(await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/send`, {}), 422, 'NOT_ACCEPTED');
  expect((await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/accept`)).body).toMatchObject({ status: 'ACCEPTED', departmentStatusText: 'Accepted', storeStatusText: 'Process' });
  err(await w.api('patch', `/departments/DYEING/yarn-requests/${r1.body.id}`, { notes: 'x' }), 422, 'NOT_PENDING');
  err(await w.api('post', `/departments/DYEING/yarn-requests/${r1.body.id}/cancel`), 422, 'NOT_PENDING');
  // what the store has for each line
  const open = (await w.api('get', `/store-yarn-outwards/requests/${r1.body.id}`)).body;
  expect(open.lines[0]).toMatchObject({ availableBags: 15 });
  expect(open.lines[0].stock.map((x) => [x.inwardNo, x.balanceBags, x.ratePerLb])).toEqual([[1, 10, 300], [2, 5, 310]]);
  // never more than asked; the store may send less
  const l1 = open.lines[0].id;
  err(await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/send`, { lines: [{ lineId: l1, bags: 13 }] }), 422, 'MORE_THAN_REQUESTED');
  err(await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/send`, { lines: [{ lineId: '11111111-1111-4111-8111-111111111111', bags: 1 }] }), 422, 'UNKNOWN_LINE');
  const sent = await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/send`, { sentThrough: 'Akram' });
  expect(sent.status).toBe(200);
  // 12 bags: 10 from the oldest entry (10 x 50 x 300 = 150,000) + 2 from the next (2 x 100 x 310 = 62,000); polyester 3 bags without a rate
  expect(sent.body).toMatchObject({ status: 'IN_WAY', departmentStatusText: 'In-Way', storeStatusText: 'In-Way', sentBags: 15, totalValue: 212000, sentThrough: 'Akram', outward: { outwardNo: 1 } });
  expect(sent.body.lines.map((l) => [l.sentBags, l.value])).toEqual([[12, 212000], [3, 0]]);
  expect(sent.body.lines[0].assigned.map((x) => [x.inwardNo, x.bags, x.lbsPerBag, x.ratePerLb, x.value])).toEqual([[1, 10, 50, 300, 150000], [2, 2, 100, 310, 62000]]);
  expect((await StoreYarnInward.findByPk(a.id)).outwardBags).toBe(10);
  expect((await StoreYarnInward.findByPk(a2.id)).outwardBags).toBe(2);
  expect((await StoreYarnInward.findByPk(b.id)).outwardBags).toBe(3);
  err(await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/send`, {}), 422, 'ALREADY_SENT');
  err(await w.api('post', `/store-yarn-outwards/requests/${r1.body.id}/reject`, { reason: 'late' }), 422, 'ALREADY_SENT');
  // the outward and the use made by the send belong to the request
  const outs = (await w.api('get', '/store-yarn-outwards')).body;
  expect(outs.data[0]).toMatchObject({ outwardNo: 1, totalBags: 15, totalValue: 212000, usedBags: 15, balanceBags: 0, canCancel: false, request: { reqNo: 1, reqText: '00001' }, department: { code: 'DYEING' } });
  err(await w.api('post', `/store-yarn-outwards/${outs.data[0].id}/cancel`), 422, 'OUTWARD_FROM_REQUEST');
  const use = (await w.api('get', '/departments/DYEING/yarn-usages')).body.data[0];
  expect(use).toMatchObject({ totalValue: 212000, canRemove: false, request: { reqNo: 1 }, soCard: { cardNo: w.so2.cardNo } });
  err(await w.api('delete', `/departments/DYEING/yarn-usages/${use.id}`), 422, 'USE_FROM_REQUEST');
  // the department's own yarn is used up at once (it went straight on the job)
  expect((await w.api('get', '/departments/DYEING/yarn?showZero=true')).body.totals).toMatchObject({ receivedBags: 15, usedBags: 15, balanceBags: 0 });
  // the department receives
  expect((await w.api('post', `/departments/DYEING/yarn-requests/${r1.body.id}/receive`)).body).toMatchObject({ status: 'DELIVERED', departmentStatusText: 'Received', storeStatusText: 'Delivered' });
  err(await w.api('post', `/departments/DYEING/yarn-requests/${r1.body.id}/receive`), 422, 'NOT_IN_WAY');

  // request 2: the whole job, 5 bags asked, the store sends only 3 (what is left of the yarn)
  const r2 = (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, lines: [{ yarnName: '22/S COTTON', bags: 5 }] })).body;
  await w.api('post', `/store-yarn-outwards/requests/${r2.id}/accept`);
  err(await w.api('post', `/store-yarn-outwards/requests/${r2.id}/send`, {}), 422, 'NOT_ENOUGH_STOCK'); // 5 asked, 3 left
  const s2 = await w.api('post', `/store-yarn-outwards/requests/${r2.id}/send`, { lines: [{ lineId: r2.lines[0].id, bags: 3 }] });
  expect(s2.body).toMatchObject({ status: 'IN_WAY', sentBags: 3, totalValue: 93000 }); // 3 x 100 x 310
  expect(s2.body.lines[0]).toMatchObject({ bags: 5, sentBags: 3 });
  // request 3: the store picks the entry; request 4: nothing to send / not in stock / rejected
  const r3 = (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, lines: [{ yarnName: '30/s Polyester', bags: 2 }] })).body;
  await w.api('post', `/store-yarn-outwards/requests/${r3.id}/accept`);
  err(await w.api('post', `/store-yarn-outwards/requests/${r3.id}/send`, { lines: [{ lineId: r3.lines[0].id, bags: 0 }] }), 422, 'NOTHING_TO_SEND');
  const s3 = await w.api('post', `/store-yarn-outwards/requests/${r3.id}/send`, { lines: [{ lineId: r3.lines[0].id, allocations: [{ inwardId: b.id, bags: 2 }] }] });
  expect(s3.body).toMatchObject({ status: 'IN_WAY', sentBags: 2, totalValue: 0 });
  const r4 = (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, lines: [{ yarnName: 'Wool', bags: 2 }] })).body;
  await w.api('post', `/store-yarn-outwards/requests/${r4.id}/accept`);
  err(await w.api('post', `/store-yarn-outwards/requests/${r4.id}/send`, {}), 422, 'NOT_ENOUGH_STOCK');
  const rej = await w.api('post', `/store-yarn-outwards/requests/${r4.id}/reject`, { reason: 'no wool' });
  expect(rej.body).toMatchObject({ status: 'REJECTED', rejectReason: 'no wool', storeStatusText: 'Rejected' });
  // a pending request can be cancelled by the department
  const r5 = (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, lines: [{ yarnName: 'Wool', bags: 2 }] })).body;
  expect((await w.api('post', `/departments/DYEING/yarn-requests/${r5.id}/cancel`)).body.status).toBe('CANCELLED');
  // lists
  const dl = (await w.api('get', '/departments/DYEING/yarn-requests')).body;
  expect([dl.total, dl.counts]).toEqual([5, { pending: 0, accepted: 0, in_way: 2, received: 1, closed: 2 }]);
  expect((await w.api('get', '/departments/DYEING/yarn-requests?tab=closed')).body.data.map((x) => x.reqNo).sort()).toEqual([4, 5]);
  expect((await w.api('get', `/departments/DYEING/yarn-requests?jobNo=${w.job.jobNo}&soNo=${w.so2.cardNo}`)).body.total).toBe(5);
  expect((await w.api('get', '/departments/DYEING/yarn-requests?reqNo=2')).body.data[0].id).toBe(r2.id);
  expect((await w.api('get', '/store-yarn-outwards/requests?tab=in_way')).body.total).toBe(2);
  expect((await w.api('get', `/store-yarn-outwards/requests?departmentId=${w.s.FOLDING.id}`)).body.total).toBe(0);

  // stock: Cotton 15 - 12 - 3 = 0; Polyester 5 - 3 - 2 = 0
  const stock = (await w.api('get', '/store-yarn-inwards/stock')).body;
  expect(stock.totals.balanceBags).toBe(0);
  expect(stock.byDepartment[0]).toMatchObject({ issuedBags: 20, usedBags: 20, balanceBags: 0, issuedValue: 305000 });
  const entry = (await w.api('get', `/store-yarn-inwards/${a2.id}`)).body;
  expect(entry.outwards.map((x) => [x.outwardNo, x.bags])).toEqual([[1, 2], [2, 3]]);
  // the cost: yarn of the job = 212,000 (SO 2 only) + 93,000 (whole job: SO 1 60 % = 55,800, SO 2 40 % = 37,200)
  const jc = (await w.api('get', `/departments/DYEING/jobs/${w.job.id}/yarn-cost`)).body;
  expect(jc.totalValue).toBe(305000);
  const c1 = (await w.api('get', `/departments/DYEING/so-cards/${w.so1.id}/yarn-cost`)).body;
  const c2 = (await w.api('get', `/departments/DYEING/so-cards/${w.so2.id}/yarn-cost`)).body;
  expect([c1.totalValue, c2.totalValue]).toEqual([55800, 249200]);
  const sc2 = (await w.api('get', `/stores/chemical/cost/so-cards/${w.so2.id}`)).body;
  expect([sc2.yarnValue, sc2.grandTotal]).toEqual([249200, 249200]);

  // the department's job list: yarn next to chemical (quantity, requests, amount) and the total of both, like the chemical columns
  const jl = (await w.api('get', `/jobs?departmentId=${w.s.DYEING.id}&side=in`)).body.data[0];
  expect(jl).toMatchObject({ yarnCount: 2, yarnBags: 20, yarnLbs: 1500, yarnAmount: 305000, yarnRequests: 3, pendingYarnRequests: 0, yarnUsages: 3, totalYarnAmount: 305000, totalCostAmount: 305000, chemicalAmount: 0 });
  const jso = (await w.api('get', `/jobs?departmentId=${w.s.DYEING.id}&side=in&view=so`)).body.data;
  expect(jso.map((x) => [x.soCard.cardNo, x.yarnCount, x.yarnBags, x.yarnLbs, x.yarnAmount, x.yarnRequests, x.totalCostAmount])).toEqual([[w.so1.cardNo, 2, 3, 300, 55800, 2, 55800], [w.so2.cardNo, 2, 17, 1200, 249200, 3, 249200]]);
  // a request still waiting at the store shows as pending on its job row
  const rp = (await w.api('post', '/departments/DYEING/yarn-requests', { jobId: w.job.id, soCardId: w.so1.id, lines: [{ yarnName: 'Wool', bags: 1 }] })).body;
  const pj = (await w.api('get', `/jobs?departmentId=${w.s.DYEING.id}&side=in&view=so`)).body.data;
  expect(pj.map((x) => x.pendingYarnRequests)).toEqual([1, 0]);
  await w.api('post', `/departments/DYEING/yarn-requests/${rp.id}/cancel`);
  // the reports carry the yarn cost and the total
  const rep = (await w.api('get', '/reports/so-cards')).body;
  expect(rep.sections[0].columns.map((c) => c.key)).toEqual(expect.arrayContaining(['chemicalCost', 'yarnCost', 'totalCost']));
  expect(rep.sections[0].rows.map((x) => [x.soNo, x.chemicalCost, x.yarnCost, x.totalCost]).sort()).toEqual([[w.so1.cardNo, 0, 55800, 55800], [w.so2.cardNo, 0, 249200, 249200]].sort());
  const det = (await w.api('get', `/reports/so-cards/${w.so2.id}`)).body;
  expect(det.header).toMatchObject({ chemicalCost: 0, yarnCost: 249200, totalCost: 249200 });
  expect(det.sections.find((x) => x.key === 'yarn').rows.map((x) => [x.department, x.yarn, x.amount])).toEqual([['Dyeing', '22/s Cotton - Crescent', 249200], ['Dyeing', '30/s Polyester', 0]]);

  // the yarn ledger: bags / lbs / value with a running balance; every outward says which request it was for
  const lg = (await w.api('get', '/store-yarn-inwards/ledger?yarn=cotton')).body;
  expect(lg.totals).toMatchObject({ inBags: 15, outBags: 15, inValue: 305000, outValue: 305000 });
  expect(lg.closing).toEqual({ bags: 0, lbs: 0, value: 0 });
  expect(lg.data.map((x) => x.kind)).toEqual(['INWARD', 'INWARD', 'OUTWARD', 'OUTWARD', 'OUTWARD']);
  expect(lg.data.filter((x) => x.kind === 'OUTWARD').map((x) => x.request.reqNo).sort()).toEqual([1, 1, 2]);
  expect(lg.data[1]).toMatchObject({ balanceBags: 15, balanceLbs: 1000, balanceValue: 305000, party: 'Yarn Mills' });
  expect(lg.data[2]).toMatchObject({ party: 'Dyeing', title: '22/s Cotton - Crescent' });
  const part = (await w.api('get', '/store-yarn-inwards/ledger?yarn=cotton&dateFrom=2026-10-15')).body;
  expect(part.opening).toEqual({ bags: 10, lbs: 500, value: 150000 });
  expect(part.data).toHaveLength(4);
  expect((await w.api('get', `/store-yarn-inwards/ledger?departmentId=${w.s.DYEING.id}`)).body.data.every((x) => x.kind === 'OUTWARD')).toBe(true);
  expect((await w.api('get', `/store-yarn-inwards/ledger?inwardId=${b.id}`)).body.closing).toEqual({ bags: 0, lbs: 0, value: 0 });
  // a yarn inward that went out on a request cannot be un-approved
  err(await w.api('post', `/store-yarn-inwards/${a.id}/unapprove`), 422, 'INWARD_IN_USE');
});

test('access: the department needs its own service, the store side needs YARN_STORE', async () => {
  const w = await setup();
  await w.api('patch', '/department-settings/DYEING', { yarnRequests: true });
  await w.api('put', `/jobs/${w.job.id}/status`, { status: 'PROCESSING' });
  await w.mk({});
  const dyerFull = await w.person('DYEING', 'FULL');
  const dyerView = await w.person('DYEING', 'VIEW');
  const folder = await w.person('FOLDING', 'FULL');
  const storeFull = await w.person('YARN_STORE', 'FULL');
  const storeView = await w.person('YARN_STORE', 'VIEW');
  const body = { jobId: w.job.id, lines: [{ yarnName: '22/s Cotton', bags: 2 }] };
  expect((await dyerView('get', '/departments/DYEING/yarn-requests')).status).toBe(200);
  expect((await dyerView('post', '/departments/DYEING/yarn-requests', body)).status).toBe(403);
  expect((await folder('get', '/departments/DYEING/yarn-requests')).status).toBe(403);
  expect((await storeFull('post', '/departments/DYEING/yarn-requests', body)).status).toBe(403);
  const r = await dyerFull('post', '/departments/DYEING/yarn-requests', body);
  expect(r.status).toBe(201);
  expect((await dyerFull('get', `/departments/DYEING/yarn-requests/${r.body.id}`)).status).toBe(200);
  expect((await storeView('get', '/store-yarn-outwards/requests')).status).toBe(200);
  expect((await storeView('post', `/store-yarn-outwards/requests/${r.body.id}/accept`)).status).toBe(403);
  expect((await dyerFull('get', '/store-yarn-outwards/requests')).status).toBe(403);
  expect((await storeFull('post', `/store-yarn-outwards/requests/${r.body.id}/accept`)).status).toBe(200);
  expect((await storeFull('post', `/store-yarn-outwards/requests/${r.body.id}/send`, {})).status).toBe(200);
  // another company sees nothing
  const o = await setup();
  expect((await o.api('get', `/store-yarn-outwards/requests/${r.body.id}`)).status).toBe(404);
  expect((await o.api('post', `/store-yarn-outwards/requests/${r.body.id}/accept`)).status).toBe(404);
  expect((await o.api('get', '/store-yarn-outwards/requests')).body.total).toBe(0);
});
