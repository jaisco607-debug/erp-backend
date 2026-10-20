const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, StoreItem, sequelize } = require('../src/models');
const catalog = require('../src/services/chemicalCatalogService');

beforeEach(clean);

test('In-Way -> Receive -> Queue -> Accept; colour by dyeing; sent-on hides; cost travels; reject comes back with reason; thaans', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'CHEMICAL_STORE', 'DYEING', 'FINISHING', 'PRINTING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  await sequelize.transaction((t) => catalog.seed(sequelize, company.id, t));
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [100, 120] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const card = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  const fd = (await api('get', '/jobs/form-data')).body;
  const job = (await api('post', '/jobs', { departmentId: s.DYEING.id, items: [{ soCardLotId: fd.rows[0].soCardLotId }] })).body;
  expect(job).toMatchObject({ status: 'IN_WAY', canReceive: true, colour: null, thaanCount: 2 });
  expect(job.items[0].thaans).toEqual([{ thaanNo: 1, meters: 100 }, { thaanNo: 2, meters: 120 }]);

  // dyeing: receive -> queue, accept -> pending
  let j = (await api('post', `/departments/DYEING/jobs/${job.id}/receive`)).body;
  expect(j).toMatchObject({ status: 'QUEUE', statusText: 'Queue', canAccept: true, receivedBy: { id: admin.id }, sentText: 'In queue at Dyeing' });
  expect((await api('put', `/departments/DYEING/jobs/${job.id}/colour`, { colourId: null })).body.error.code).toBe('NOT_ACCEPTED');
  j = (await api('post', `/departments/DYEING/jobs/${job.id}/accept`)).body;
  expect(j).toMatchObject({ status: 'PENDING', acceptedBy: { id: admin.id }, canSetColour: true });
  await api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'PROCESSING' });

  // colour for the SO card
  const black = (await api('post', '/colours', { name: 'BLACK' })).body;
  j = (await api('put', `/departments/DYEING/jobs/${job.id}/colour`, { colourId: black.id, soCardId: card.id })).body;
  expect(j.colour).toMatchObject({ name: 'BLACK' });

  // chemical used in dyeing: 2 kg at 100
  const red = await StoreItem.findOne({ where: { companyId: company.id, store: 'CHEMICAL', name: 'RED' } });
  await api('post', '/stores/chemical/inwards', { inwardDate: '2026-10-12', vendorName: 'ALI', lines: [{ itemId: red.id, qty: 10, rate: 100 }], approve: true });
  await api('put', '/stores/chemical/department-access/DYEING', { add: [red.id] });
  await api('put', '/stores/chemical/department-access/FINISHING', { add: [red.id] });
  const r = (await api('post', '/departments/DYEING/chemical-requests', { jobId: job.id, lines: [{ itemId: red.id, qty: 2 }] })).body;
  await api('post', `/stores/chemical/requests/${r.id}/accept`);
  await api('post', `/stores/chemical/requests/${r.id}/send`);
  await api('put', `/departments/DYEING/jobs/${job.id}/status`, { status: 'COMPLETE' });

  // dyeing sends on to finishing: gone from dyeing's list, still under "sent"
  // operator name + process date, editable until sent on
  let op = (await api('put', `/departments/DYEING/jobs/${job.id}/operator`, { operatorName: 'Aslam', processDate: '2026-10-18' })).body;
  expect(op).toMatchObject({ operatorName: 'Aslam', processDate: '2026-10-18' });
  op = (await api('put', `/departments/DYEING/jobs/${job.id}/operator`, { processDate: '2026-10-19' })).body;
  expect(op).toMatchObject({ operatorName: 'Aslam', processDate: '2026-10-19' });
  expect((await api('get', '/departments/DYEING/incoming')).body.data[0]).toMatchObject({ canEditOperator: true, processDate: '2026-10-19' });
  let form = (await api('get', `/departments/DYEING/send-form?jobId=${job.id}`)).body;
  expect(form.canSetColour).toBe(true);
  expect(form.rows[0]).toMatchObject({ selected: true, colour: 'BLACK' });
  const fin = (await api('post', '/departments/DYEING/send', { toDepartmentCode: 'FINISHING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  expect(fin.colour).toMatchObject({ name: 'BLACK' });
  expect((await api('get', '/departments/DYEING/incoming')).body.total).toBe(0);
  expect((await api('put', `/departments/DYEING/jobs/${job.id}/operator`, { processDate: '2026-10-20' })).body.error.code).toBe('ALREADY_SENT_ON');
  expect((await api('get', '/departments/DYEING/incoming?show=sent')).body.data[0]).toMatchObject({ sentOn: true, sentTo: [{ department: 'Finishing' }] });

  // finishing sees earlier cost (200), its own (100 after its request), total
  await api('post', `/departments/FINISHING/jobs/${fin.id}/accept`);
  await api('put', `/departments/FINISHING/jobs/${fin.id}/status`, { status: 'PROCESSING' });
  const r2 = (await api('post', '/departments/FINISHING/chemical-requests', { jobId: fin.id, lines: [{ itemId: red.id, qty: 1 }] })).body;
  await api('post', `/stores/chemical/requests/${r2.id}/accept`);
  await api('post', `/stores/chemical/requests/${r2.id}/send`);
  let row = (await api('get', '/departments/FINISHING/incoming')).body.data[0];
  expect(row.firstJobNos).toEqual([job.jobNo]);
  expect(row.items[0].firstJobNo).toBe(job.jobNo);
  expect(row).toMatchObject({ previousChemicalAmount: 200, chemicalAmount: 100, totalChemicalAmount: 300, totalCostPerMeter: 1.3636, colour: { name: 'BLACK' }, thaanCount: 2 });
  const so = (await api('get', '/departments/FINISHING/incoming?view=so')).body.data[0];
  expect(so).toMatchObject({ previousChemicalAmount: 200, chemicalAmount: 100, totalChemicalAmount: 300, colour: { name: 'BLACK' }, thaanCount: 2 });

  // finishing sends to printing; printing rejects (wrong colour): back in finishing with reason
  await api('put', `/departments/FINISHING/jobs/${fin.id}/status`, { status: 'COMPLETE' });
  await api('put', `/departments/FINISHING/jobs/${fin.id}/operator`, { operatorName: 'Bilal', processDate: '2026-10-19' });
  form = (await api('get', '/departments/FINISHING/send-form')).body;
  expect(form.canSetColour).toBe(false);
  expect(form.rows[0].selected).toBe(false);
  expect((await api('post', '/departments/FINISHING/send', { toDepartmentCode: 'PRINTING', colourId: black.id, items: [{ jobItemId: form.rows[0].jobItemId }] })).body.error.code).toBe('COLOUR_ONLY_DYEING');
  const pr = (await api('post', '/departments/FINISHING/send', { toDepartmentCode: 'PRINTING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  expect((await api('get', '/departments/FINISHING/incoming')).body.total).toBe(0);
  await api('post', `/departments/PRINTING/jobs/${pr.id}/reject`, { reason: 'Colour sahi nahi hua' });
  row = (await api('get', '/departments/FINISHING/incoming')).body.data[0];
  expect(row).toMatchObject({ sentOn: false, rejectedBack: { department: 'Printing', reason: 'Colour sahi nahi hua' } });
  // finishing can send it again to any department
  form = (await api('get', '/departments/FINISHING/send-form')).body;
  expect(form.rows).toHaveLength(1);
  expect((await api('get', '/departments/PRINTING/incoming')).body.data.map((x) => x.status)).toEqual(['REJECTED']);
  const again = (await api('post', '/departments/FINISHING/send', { toDepartmentCode: 'DYEING', items: [{ jobItemId: form.rows[0].jobItemId }] })).body;
  // printing's rejected entry leaves its list once finishing sent the cloth again (kept under show=sent)
  expect((await api('get', '/departments/PRINTING/incoming')).body.total).toBe(0);
  expect((await api('get', '/departments/PRINTING/incoming?show=sent')).body.data[0].status).toBe('REJECTED');
  expect(again.status).toBe('IN_WAY');
  expect((await api('get', '/departments/FINISHING/incoming')).body.total).toBe(0);
  // dyeing rejects; finishing says the reason is not valid: back to dyeing (Queue) with a message
  await api('post', `/departments/DYEING/jobs/${again.id}/reject`, { reason: 'Kapra geela hai' });
  expect((await api('get', '/departments/FINISHING/incoming')).body.data[0].rejectedBack).toMatchObject({ department: 'Dyeing', canAnswer: true });
  expect((await api('post', `/departments/FINISHING/jobs/${again.id}/reject-answer`, { decision: 'DISPUTE' })).body.error.code).toBe('REASON_REQUIRED');
  const back = (await api('post', `/departments/FINISHING/jobs/${again.id}/reject-answer`, { decision: 'DISPUTE', reason: 'Kapra sookha bheja tha' })).body;
  expect(back).toMatchObject({ status: 'QUEUE', rejectAnswer: 'DISPUTED', rejectionRejected: { yourReason: 'Kapra geela hai', reason: 'Kapra sookha bheja tha', department: 'Finishing' } });
  expect((await api('get', '/departments/FINISHING/incoming')).body.total).toBe(0);
  expect((await api('get', '/departments/DYEING/incoming')).body.data.find((x) => x.id === again.id).rejectionRejected.reason).toBe('Kapra sookha bheja tha');
  expect((await api('post', `/departments/DYEING/jobs/${again.id}/reject`, { reason: 'phir se' })).body.error.code).toBe('REJECT_DISPUTED');
  expect((await api('put', `/departments/FINISHING/jobs/${fin.id}/colour`, { colourId: black.id })).body.error.code).toBe('NO_COLOUR_HERE');
});
