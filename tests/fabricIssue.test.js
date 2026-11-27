const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, FabricInward } = require('../src/models');

jest.setTimeout(300000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };

async function setup() {
  const company = await makeCompany();
  for (const code of ['FABRIC_STORE', 'GREY_STORE', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = call(admin);
  const desk = await makeUser({ userType: 'USER', companyId: company.id }); // SO card desk only
  await UserService.create({ userId: desk.id, serviceId: (await Service.findOne({ where: { code: 'SO_CARD' } })).id, access: 'FULL' });
  const nobody = await makeUser({ userType: 'USER', companyId: company.id });
  const az = (await api('post', '/customers', { name: 'AZ' })).body;
  const bb = (await api('post', '/customers', { name: 'BB' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const vendor = (await api('post', '/vendors', { name: 'Cloth Mills' })).body;
  // the customer's own cloth and its SO card (the one whose cloth was spoilt)
  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: az.id, qualityId: q.id, thaans: [60, 40] })).body;
  await api('post', `/grey-lots/${lot.id}/approve`);
  const card1 = (await api('post', '/so-cards', { cardDate: '2026-10-16', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body;
  // the cloth bought from the vendor
  const inward = (await api('post', '/fabric-inwards', { inwardDate: '2026-11-01', vendorId: vendor.id, qualityId: q.id, dcNo: 'V-1', thaans: [30, 30, 40] })).body;
  await api('post', `/fabric-inwards/${inward.id}/approve`);
  return { company, api, desk: call(desk), nobody: call(nobody), az, bb, q, vendor, lot, card1, inward };
}

test('issue store cloth to an SO card, linked to the spoilt card: customer comes from the link, stock falls, the card says its cloth is from the store', async () => {
  const w = await setup();
  expect(w.card1.clothSource).toBe('CUSTOMER');
  const is = await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [1, 2], linkedSoCardId: w.card1.id, issueDate: '2026-11-05', remarks: 'spoilt in dyeing' });
  expect(is.status).toBe(201);
  expect(is.body).toMatchObject({ issueNo: 1, issueText: '00001', meters: 60, pieces: 2, status: 'ISSUED', isLinked: true, canCancel: true, usedMeters: 0 });
  expect(is.body.customer.name).toBe('AZ');
  expect(is.body.linkedSoCard).toMatchObject({ id: w.card1.id, cardNo: w.card1.cardNo });
  expect(is.body.fabricInward).toMatchObject({ inwardNo: 1, dcNo: 'V-1' });
  // stock: 60 m gone, thaan 3 is left
  const st = await w.api('get', '/fabric-inwards/stock?withThaans=true');
  expect(st.body.totals).toMatchObject({ inwardMeters: 100, outwardMeters: 60, balanceMeters: 40 });
  expect(st.body.data[0]).toMatchObject({ freePieces: 1, freeThaanNos: [3] });
  expect(st.body.data[0].thaans.map((t) => t.thaanNo)).toEqual([3]);
  // the lot is a normal approved lot of the customer, marked STORE; the SO card desk picks it from available-lots
  const av = await w.api('get', '/so-cards/available-lots?source=STORE');
  expect(av.body.data.map((l) => [l.id, l.fromStore, l.customer.name, l.balanceMeters])).toEqual([[is.body.greyLotId, true, 'AZ', 60]]);
  expect((await w.api('get', '/so-cards/available-lots?source=CUSTOMER')).body.data.some((l) => l.fromStore)).toBe(false);
  // the grey inward screen cannot change it
  err(await w.api('patch', `/grey-lots/${is.body.greyLotId}`, { remarks: 'x' }), 422, 'STORE_LOT');
  err(await w.api('delete', `/grey-lots/${is.body.greyLotId}`, { reason: 'Entered by mistake' }), 422, 'STORE_LOT');
  err(await w.api('post', `/grey-lots/${is.body.greyLotId}/unapprove`), 422, 'STORE_LOT');
  err(await w.api('post', `/grey-lots/${is.body.greyLotId}/give-back`, { thaanNos: [1] }), 422, 'STORE_LOT');
  expect((await w.api('get', '/grey-lots?source=STORE')).body.data.map((l) => l.source)).toEqual(['STORE']);
  // the new SO card
  const card2 = await w.api('post', '/so-cards', { cardDate: '2026-11-06', lots: [{ greyLotId: is.body.greyLotId, thaanNos: [1, 2] }] });
  expect(card2.status).toBe(201);
  expect(card2.body).toMatchObject({ clothSource: 'STORE', clothSourceText: 'Store cloth', totalMeters: 60 });
  expect(card2.body.replacesSoCards.map((c) => c.id)).toEqual([w.card1.id]);
  expect(card2.body.lots[0]).toMatchObject({ source: 'STORE', fromStore: true });
  expect(card2.body.lots[0].storeIssue).toMatchObject({ issueNo: 1, inwardNo: 1, inwardText: '00001', vendorName: 'Cloth Mills' });
  expect(card2.body.lots[0].storeIssue.linkedSoCard.id).toBe(w.card1.id);
  expect((await w.api('get', `/so-cards/${card2.body.id}`)).body.clothSource).toBe('STORE');
  expect((await w.api('get', `/so-cards/${w.card1.id}`)).body.replacesSoCards).toEqual([]);
  // the issue now shows the card that used it, and cannot be cancelled
  const one = await w.api('get', `/fabric-inwards/issues/${is.body.id}`);
  expect(one.body).toMatchObject({ usedMeters: 60, canCancel: false });
  expect(one.body.soCards.map((c) => [c.id, c.meters])).toEqual([[card2.body.id, 60]]);
  err(await w.api('post', `/fabric-inwards/issues/${is.body.id}/cancel`), 422, 'ISSUE_IN_USE');
  // the entry shows what was issued out of it
  const e = await w.api('get', `/fabric-inwards/${w.inward.id}`);
  expect(e.body.issues.map((i) => [i.issueNo, i.customer.name, i.linkedSoCard.cardNo])).toEqual([[1, 'AZ', w.card1.cardNo]]);
  // a card that mixes the customer's own cloth with store cloth
  const own = (await w.api('post', '/grey-lots', { inwardDate: '2026-11-02', customerId: w.az.id, qualityId: w.q.id, thaans: [20] })).body;
  await w.api('post', `/grey-lots/${own.id}/approve`);
  const is2 = await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [3], customerId: w.az.id, issueDate: '2026-11-05' });
  expect([is2.status, is2.body.isLinked, is2.body.linkedSoCard]).toEqual([201, false, null]);
  const mixed = await w.api('post', '/so-cards', { cardDate: '2026-11-06', lots: [{ greyLotId: own.id, thaanNos: [1] }, { greyLotId: is2.body.greyLotId, thaanNos: [1] }] });
  expect([mixed.status, mixed.body.clothSource, mixed.body.replacesSoCards]).toEqual([201, 'MIXED', []]);
  // the card the cloth replaces says so: "Replaced by SO n"; the new card says what it replaces
  const old = (await w.api('get', `/so-cards/${w.card1.id}`)).body;
  expect(old).toMatchObject({ isReplaced: true, replacedText: `Replaced by SO ${card2.body.cardNo}` });
  expect(old.replacedBy.map((i) => [i.issueNo, i.meters, i.soCards.map((c) => c.id)])).toEqual([[1, 60, [card2.body.id]]]);
  expect(card2.body.replacesText).toBe(`Made to replace SO ${w.card1.cardNo}`);
  expect((await w.api('get', '/so-cards')).body.data.find((c) => c.id === w.card1.id).isReplaced).toBe(true);
  // cancelling a card that holds store cloth sends the cloth BACK TO THE STORE (not "cancelled"): the issue is RETURNED, the thaans are in the stock again
  expect((await w.api('delete', `/so-cards/${mixed.body.id}`)).status).toBe(204);
  const back = await w.api('get', `/fabric-inwards/issues/${is2.body.id}`);
  expect([back.body.status, back.body.statusText, back.body.canCancel]).toEqual(['RETURNED', 'Returned to store', true]);
  expect((await w.api('get', '/fabric-inwards/stock')).body.totals.balanceMeters).toBe(40);
  expect((await w.api('get', '/fabric-inwards/issues?status=RETURNED')).body.data.map((i) => i.id)).toEqual([is2.body.id]);
  expect((await w.api('get', '/fabric-inwards/ledger')).body.data.map((r) => r.kind)).toEqual(['INWARD', 'ISSUE', 'ISSUE', 'ISSUE_RETURN']);
  // a RETURNED issue can be deleted: the row is gone and leaves no trace in the ledger
  const del = await w.api('post', `/fabric-inwards/issues/${is2.body.id}/cancel`);
  expect([del.status, del.body]).toEqual([200, { id: is2.body.id, issueNo: 2, deleted: true }]);
  expect((await w.api('get', `/fabric-inwards/issues/${is2.body.id}`)).status).toBe(404);
  expect((await w.api('get', '/fabric-inwards/ledger')).body.data.map((r) => r.kind)).toEqual(['INWARD', 'ISSUE']);
  // the customer's own lot of that card is untouched
  expect((await w.api('get', `/grey-lots/${own.id}`)).body.outwardMeters).toBe(0);
  // option CANCEL: the issue is deleted (no trace); option KEEP: the lot stays with the customer and the issue stays issued
  expect((await w.api('delete', `/so-cards/${card2.body.id}?storeAction=CANCEL`)).status).toBe(204);
  expect((await w.api('get', `/fabric-inwards/issues/${is.body.id}`)).status).toBe(404);
  expect((await w.api('get', '/fabric-inwards/ledger')).body.data.map((r) => r.kind)).toEqual(['INWARD']);
  expect((await w.api('get', `/fabric-inwards/${w.inward.id}`)).body.balanceMeters).toBe(100);
  expect((await w.api('get', `/so-cards/${w.card1.id}`)).body.isReplaced).toBe(false);
  const is3 = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [1, 2], linkedSoCardId: w.card1.id, issueDate: '2026-11-05' })).body;
  const card3 = (await w.api('post', '/so-cards', { cardDate: '2026-11-06', lots: [{ greyLotId: is3.greyLotId, thaanNos: [1, 2] }] })).body;
  expect((await w.api('delete', `/so-cards/${card3.id}?storeAction=KEEP`)).status).toBe(204);
  expect((await w.api('get', `/fabric-inwards/issues/${is3.id}`)).body).toMatchObject({ status: 'ISSUED', canCancel: true });
  expect((await w.api('get', '/so-cards?limit=5')).status).toBe(200);
  err(await w.api('delete', `/so-cards/${card3.id}?storeAction=BAD`), 400, 'VALIDATION_FAILED');
  // the thaan can be issued again
  expect((await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [3], customerId: w.bb.id })).status).toBe(201);
});

test('issue rules: customer or link, thaans, balance, approved only, access', async () => {
  const w = await setup();
  const base = { fabricInwardId: w.inward.id };
  err(await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1] }), 400, 'VALIDATION_FAILED'); // neither customer nor link
  err(await w.api('post', '/fabric-inwards/issues', { ...base, customerId: w.bb.id }), 400, 'VALIDATION_FAILED'); // neither thaans nor meters
  err(await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1], customerId: w.bb.id, linkedSoCardId: w.card1.id }), 422, 'LINK_OTHER_CUSTOMER');
  err(await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [9], customerId: w.bb.id }), 422, 'UNKNOWN_THAAN');
  err(await w.api('post', '/fabric-inwards/issues', { ...base, meters: 10, customerId: w.bb.id }), 422, 'PICK_THAANS');
  err(await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1], customerId: w.bb.id, issueDate: '2026-10-01' }), 422, 'ISSUE_BEFORE_INWARD');
  expect((await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1], customerId: w.bb.id })).status).toBe(201);
  err(await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1], customerId: w.bb.id }), 422, 'THAAN_TAKEN');
  // an entry that is not approved is not in the stock
  const draft = (await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-01', vendorId: w.vendor.id, qualityId: w.q.id, thaans: [10] })).body;
  err(await w.api('post', '/fabric-inwards/issues', { fabricInwardId: draft.id, thaanNos: [1], customerId: w.bb.id }), 422, 'INWARD_NOT_APPROVED');
  // an entry without a thaan list is issued by meters
  const plain = (await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-01', vendorId: w.vendor.id, qualityId: w.q.id, inwardMeters: 100, pieces: 4 })).body;
  await w.api('post', `/fabric-inwards/${plain.id}/approve`);
  err(await w.api('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, thaanNos: [1], customerId: w.bb.id }), 422, 'UNKNOWN_THAAN');
  err(await w.api('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, meters: 150, customerId: w.bb.id }), 422, 'NOT_ENOUGH_METERS');
  const m = await w.api('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, meters: 70, pieces: 3, customerId: w.bb.id });
  expect([m.status, m.body.meters, m.body.pieces]).toEqual([201, 70, 3]);
  expect((await FabricInward.findByPk(plain.id)).outwardMeters).toBe(70);
  // cloth that has gone out: the entry cannot be un-approved
  err(await w.api('post', `/fabric-inwards/${plain.id}/unapprove`), 422, 'INWARD_IN_USE');
  // access: the SO card desk (SO_CARD only) can pick and issue; a person without either service cannot
  expect((await w.desk('get', '/fabric-inwards/stock')).status).toBe(200);
  expect((await w.desk('get', '/fabric-inwards/link-cards')).status).toBe(200);
  expect((await w.desk('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, meters: 10, customerId: w.bb.id })).status).toBe(201);
  expect((await w.desk('get', '/fabric-inwards/issues')).status).toBe(403); // the lists and the ledger are the Fabric Store's
  expect((await w.nobody('get', '/fabric-inwards/stock')).status).toBe(403);
  expect((await w.nobody('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, meters: 10, customerId: w.bb.id })).status).toBe(403);
  // link-cards: the cards to link, by customer and number
  const lc = await w.api('get', `/fabric-inwards/link-cards?customerId=${w.az.id}`);
  expect(lc.body.data.map((c) => [c.id, c.customer.name])).toEqual([[w.card1.id, 'AZ']]);
  expect((await w.api('get', `/fabric-inwards/link-cards?customerId=${w.bb.id}`)).body.data).toEqual([]);
  expect((await w.api('get', `/fabric-inwards/link-cards?search=${w.card1.cardNo}`)).body.data).toHaveLength(1);
});

test('issue list, summary per customer / linked card, and the Fabric Store ledger with running balance', async () => {
  const w = await setup();
  const a = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [1], linkedSoCardId: w.card1.id, issueDate: '2026-11-03' })).body; // AZ 30
  const b = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [3], customerId: w.bb.id, issueDate: '2026-11-04' })).body; // BB 40, deleted below
  expect((await w.api('post', `/fabric-inwards/issues/${b.id}/cancel`)).body.deleted).toBe(true);
  const c = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: w.inward.id, thaanNos: [2], customerId: w.bb.id, issueDate: '2026-11-04' })).body; // BB 30, returned below
  const cardC = (await w.api('post', '/so-cards', { cardDate: '2026-11-05', lots: [{ greyLotId: c.greyLotId, thaanNos: [1] }] })).body;
  expect((await w.api('delete', `/so-cards/${cardC.id}`)).status).toBe(204);
  const l = await w.api('get', '/fabric-inwards/issues');
  expect([l.body.total, l.body.data.map((x) => [x.issueNo, x.status, x.canEdit, x.canCancel])]).toEqual([2, [[3, 'RETURNED', true, true], [1, 'ISSUED', true, true]]]);
  expect(l.body.totals).toMatchObject({ issues: 1, meters: 30, linkedIssues: 1, unlinkedIssues: 0 });
  expect((await w.api('get', '/fabric-inwards/issues?customerId=' + w.bb.id)).body.total).toBe(1);
  expect((await w.api('get', '/fabric-inwards/issues?status=RETURNED')).body.total).toBe(1);
  expect((await w.api('get', '/fabric-inwards/issues?status=CANCELLED')).status).toBe(400);
  expect((await w.api('get', '/fabric-inwards/issues?linked=false&status=ISSUED')).body.total).toBe(0);
  expect((await w.api('get', `/fabric-inwards/issues?linkedSoCardId=${w.card1.id}`)).body.total).toBe(1);
  expect((await w.api('get', '/fabric-inwards/issues?search=AZ')).body.total).toBe(1);
  const g = await w.api('get', '/fabric-inwards/issues?groupBy=customer');
  expect(g.body.groups.map((x) => [x.label, x.meters, x.issues])).toEqual([['AZ', 30, 1]]);
  expect((await w.api('get', '/fabric-inwards/issues?groupBy=linkedCard')).body.groups.map((x) => [x.label, x.meters])).toEqual([[`SO ${w.card1.cardNo}`, 30]]);
  expect((await w.api('get', '/fabric-inwards/issues?groupBy=vendor')).body.groups.map((x) => x.label)).toEqual(['Cloth Mills']);
  // ledger: +100 inward, -30 issue 1, -30 issue 3, +30 issue 3 returned (the deleted issue left no trace)
  const lg = await w.api('get', '/fabric-inwards/ledger');
  expect(lg.status).toBe(200);
  expect(lg.body.data.map((r) => [r.kind, r.inMeters, r.outMeters, r.balanceMeters])).toEqual([['INWARD', 100, 0, 100], ['ISSUE', 0, 30, 70], ['ISSUE', 0, 30, 40], ['ISSUE_RETURN', 30, 0, 70]]);
  expect(lg.body).toMatchObject({ opening: 0, closing: 70, totals: { inMeters: 130, outMeters: 60 } });
  expect(lg.body.data[1]).toMatchObject({ party: 'AZ', linkedSoCard: String(w.card1.cardNo), refText: '00001', lotNo: expect.any(Number) });
  const part = await w.api('get', '/fabric-inwards/ledger?dateFrom=2026-11-03&dateTo=2026-11-03');
  expect(part.body).toMatchObject({ opening: 100, closing: 70 });
  expect(part.body.data).toHaveLength(1);
  const cu = await w.api('get', `/fabric-inwards/ledger?customerId=${w.az.id}`);
  expect(cu.body.data.map((r) => r.kind)).toEqual(['ISSUE']);
  expect((await w.api('get', `/fabric-inwards/ledger?fabricInwardId=${w.inward.id}`)).body.total).toBe(4);
  expect((await w.api('get', `/fabric-inwards/ledger?qualityId=${w.q.id}&vendorId=${w.vendor.id}`)).body.total).toBe(4);
  expect(a.issueNo).toBe(1);
});

test('cancel (= delete) an issue, edit an ISSUED one, edit a RETURNED one and issue it again', async () => {
  const w = await setup();
  const base = { fabricInwardId: w.inward.id, issueDate: '2026-11-05' };
  const stock = async () => (await w.api('get', '/fabric-inwards/stock')).body.totals.balanceMeters;
  // cancel an ISSUED issue: the row is gone, the thaans are free, the ledger is as if it never happened
  const a = (await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1, 2], customerId: w.bb.id })).body;
  expect(await stock()).toBe(40);
  expect((await w.api('post', `/fabric-inwards/issues/${a.id}/cancel`)).status).toBe(200);
  expect([await stock(), (await w.api('get', '/fabric-inwards/issues')).body.total]).toEqual([100, 0]);
  expect((await w.api('get', '/fabric-inwards/ledger')).body.data.map((r) => r.kind)).toEqual(['INWARD']);
  expect((await w.api('get', `/fabric-inwards/${w.inward.id}`)).body.issues).toEqual([]);
  expect((await w.api('get', '/grey-lots?source=STORE')).body.total).toBe(0);
  expect((await w.api('post', `/fabric-inwards/issues/${a.id}/cancel`)).status).toBe(404);

  // edit an ISSUED issue that is on no SO card: other thaans, other customer, link added; it keeps its number, gets a new lot
  const b = (await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1, 2], customerId: w.bb.id, remarks: 'first' })).body;
  const form = (await w.api('get', `/fabric-inwards/issues/${b.id}`)).body;
  expect(form).toMatchObject({ canEdit: true, canCancel: true, thaanNos: [1, 2], editBalanceMeters: null, issueDate: '2026-11-05' });
  expect(form.fabricInward.inwardDate).toBe('2026-11-01');
  expect(form.editThaans.map((t) => [t.thaanNo, t.meters, t.selected])).toEqual([[1, 30, true], [2, 30, true], [3, 40, false]]);
  const e1 = await w.api('patch', `/fabric-inwards/issues/${b.id}`, { thaanNos: [2, 3], linkedSoCardId: w.card1.id });
  expect(e1.status).toBe(200);
  expect(e1.body).toMatchObject({ id: b.id, issueNo: 2, status: 'ISSUED', meters: 70, pieces: 2, thaanNos: [2, 3], isLinked: true, remarks: 'first' });
  expect(e1.body.customer.name).toBe('AZ');
  expect(e1.body.greyLotId).not.toBe(b.greyLotId);
  expect(await stock()).toBe(30);
  expect((await w.api('get', '/fabric-inwards/stock?withThaans=true')).body.data[0].freeThaanNos).toEqual([1]);
  expect((await w.api('get', '/grey-lots?source=STORE')).body.total).toBe(1); // the old lot is gone, one new lot
  // nothing sent for the cloth = the same cloth; link removed + other customer
  const e2 = await w.api('patch', `/fabric-inwards/issues/${b.id}`, { linkedSoCardId: null, customerId: w.bb.id, remarks: 'second' });
  expect([e2.status, e2.body.isLinked, e2.body.customer.name, e2.body.thaanNos, e2.body.meters, e2.body.remarks]).toEqual([200, false, 'BB', [2, 3], 70, 'second']);
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, { thaanNos: [9] }), 422, 'UNKNOWN_THAAN');
  expect(await stock()).toBe(30); // a refused edit changes nothing
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, { fabricInwardId: (await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-01', vendorId: w.vendor.id, qualityId: w.q.id, thaans: [5] })).body.id }), 422, 'INWARD_NOT_CHANGEABLE');
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, { customerId: w.bb.id, linkedSoCardId: w.card1.id }), 422, 'LINK_OTHER_CUSTOMER');
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, { issueDate: '2026-10-01' }), 422, 'ISSUE_BEFORE_INWARD');
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, {}), 400, 'VALIDATION_FAILED');
  // another thaan is taken by someone else
  const other = (await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [1], customerId: w.az.id })).body;
  err(await w.api('patch', `/fabric-inwards/issues/${b.id}`, { thaanNos: [1, 2] }), 422, 'THAAN_TAKEN');

  // on an SO card: edit and cancel are refused (ISSUE_IN_USE)
  const card = (await w.api('post', '/so-cards', { cardDate: '2026-11-06', lots: [{ greyLotId: e2.body.greyLotId, thaanNos: [1, 2] }] })).body;
  const used = (await w.api('get', `/fabric-inwards/issues/${b.id}`)).body;
  expect([used.canEdit, used.canCancel, used.editThaans]).toEqual([false, false, []]);
  const r1 = await w.api('patch', `/fabric-inwards/issues/${b.id}`, { remarks: 'x' });
  err(r1, 422, 'ISSUE_IN_USE');
  expect(r1.body.error.details.soCards).toHaveLength(1);
  err(await w.api('post', `/fabric-inwards/issues/${b.id}/cancel`), 422, 'ISSUE_IN_USE');

  // edit a RETURNED issue (the card is cancelled, the cloth is back): fewer thaans, other customer, new lot, ISSUED again with the same number
  expect((await w.api('delete', `/so-cards/${card.id}`)).status).toBe(204);
  const ret = (await w.api('get', `/fabric-inwards/issues/${b.id}`)).body;
  expect(ret).toMatchObject({ status: 'RETURNED', statusText: 'Returned to store', canEdit: true, canCancel: true, thaanNos: [2, 3] });
  expect(ret.editThaans.map((t) => [t.thaanNo, t.selected])).toEqual([[2, true], [3, true]]);
  expect(await stock()).toBe(70);
  const e3 = await w.api('patch', `/fabric-inwards/issues/${b.id}`, { thaanNos: [3], customerId: w.az.id, issueDate: '2026-11-07' });
  expect(e3.status).toBe(200);
  expect(e3.body).toMatchObject({ id: b.id, issueNo: 2, status: 'ISSUED', meters: 40, pieces: 1, thaanNos: [3], cancelledAt: null, issueDate: '2026-11-07' });
  expect(e3.body.customer.name).toBe('AZ');
  expect(await stock()).toBe(30);
  expect((await w.api('get', '/fabric-inwards/issues?status=RETURNED')).body.total).toBe(0);
  const lots = (await w.api('get', '/grey-lots?source=STORE')).body.data;
  expect(lots.map((l) => l.id).sort()).toEqual([e3.body.greyLotId, other.greyLotId].sort());
  // the edited issue gets its SO card; the returned-then-issued cloth works like any issue
  expect((await w.api('post', '/so-cards', { cardDate: '2026-11-08', lots: [{ greyLotId: e3.body.greyLotId, thaanNos: [1] }] })).status).toBe(201);

  // delete a RETURNED issue
  const c = (await w.api('post', '/fabric-inwards/issues', { ...base, thaanNos: [2], customerId: w.az.id })).body;
  const cc = (await w.api('post', '/so-cards', { cardDate: '2026-11-06', lots: [{ greyLotId: c.greyLotId, thaanNos: [1] }] })).body;
  await w.api('delete', `/so-cards/${cc.id}`);
  expect((await w.api('get', `/fabric-inwards/issues/${c.id}`)).body.status).toBe('RETURNED');
  expect((await w.api('post', `/fabric-inwards/issues/${c.id}/cancel`)).status).toBe(200);
  expect((await w.api('get', `/fabric-inwards/issues/${c.id}`)).status).toBe(404);
  expect(await stock()).toBe(30);
  // an entry without a thaan list is edited by meters
  const plain = (await w.api('post', '/fabric-inwards', { inwardDate: '2026-11-01', vendorId: w.vendor.id, qualityId: w.q.id, inwardMeters: 100, pieces: 4 })).body;
  await w.api('post', `/fabric-inwards/${plain.id}/approve`);
  const p = (await w.api('post', '/fabric-inwards/issues', { fabricInwardId: plain.id, meters: 70, pieces: 3, customerId: w.bb.id, issueDate: '2026-11-05' })).body;
  const pf = (await w.api('get', `/fabric-inwards/issues/${p.id}`)).body;
  expect([pf.editThaans, pf.editBalanceMeters]).toEqual([[], 100]);
  err(await w.api('patch', `/fabric-inwards/issues/${p.id}`, { meters: 120 }), 422, 'NOT_ENOUGH_METERS');
  const pe = await w.api('patch', `/fabric-inwards/issues/${p.id}`, { meters: 90 });
  expect([pe.status, pe.body.meters, pe.body.pieces]).toEqual([200, 90, 0]);
  expect((await FabricInward.findByPk(plain.id)).outwardMeters).toBe(90);
  // another company
  const o = await setup();
  expect((await o.api('get', `/fabric-inwards/issues/${b.id}`)).status).toBe(404);
  expect((await o.api('patch', `/fabric-inwards/issues/${b.id}`, { remarks: 'x' })).status).toBe(404);
  expect((await o.api('post', `/fabric-inwards/issues/${b.id}/cancel`)).status).toBe(404);
  // access: the SO card desk may edit; a person without the service may not
  expect((await w.desk('patch', `/fabric-inwards/issues/${p.id}`, { remarks: 'by desk' })).status).toBe(200);
  expect((await w.nobody('patch', `/fabric-inwards/issues/${p.id}`, { remarks: 'no' })).status).toBe(403);
});
