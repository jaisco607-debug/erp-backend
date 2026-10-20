const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

test('SO card thaan-wise, lot figures on the card, two cards sent as one job, operator name', async () => {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'STITCHING'].filter(Boolean)) {
    s[code] = await Service.findOne({ where: { code } });
    if (s[code]) await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ TEXTILES' })).body;
  const cu2 = (await api('post', '/customers', { name: 'GUL AHMED' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const mk = async (customerId, body) => {
    const l = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId, qualityId: q.id, ...body })).body;
    await api('post', `/grey-lots/${l.id}/approve`);
    return l;
  };
  const lot = await mk(cu.id, { thaans: [100, 120, 80, 50], glm: 145.5, gsm: 120 });
  const plain = await mk(cu.id, { inwardMeters: 1000, pieces: 10 });
  const other = await mk(cu2.id, { thaans: [60] });

  const av = (await api('get', `/so-cards/available-lots?customerId=${cu.id}`)).body.data.find((l) => l.id === lot.id);
  expect(av).toMatchObject({ isThaanWise: true, glm: 145.5, gsm: 120, balanceMeters: 350, soCardMeters: 0, balancePieces: 4 });

  // lot with thaans must be picked by thaan
  expect((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, meters: 100 }] })).body.error.code).toBe('PICK_THAANS');
  expect((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1] }, { greyLotId: other.id, thaanNos: [1] }] })).body.error.code).toBe('MIXED_CUSTOMERS');

  const c1 = (await api('post', '/so-cards', { cardDate: '2026-10-15', deliveryDate: '2026-10-30', article: 'BEDSHEET 90x100', instructions: 'Soft finish', lots: [{ greyLotId: lot.id, thaanNos: [1, 3] }, { greyLotId: plain.id, meters: 400 }] })).body;
  expect(c1).toMatchObject({ deliveryDate: '2026-10-30', article: 'BEDSHEET 90x100', instructions: 'Soft finish' });
  expect(c1.totalMeters).toBe(580);
  expect(c1.lots.find((l) => l.greyLotId === lot.id)).toMatchObject({
    meters: 180, pieces: 2, thaanNos: [1, 3], glm: 145.5, gsm: 120, outBefore: 0, balanceBefore: 350, balanceAfter: 170, isThaanWise: true,
  });
  // those thaans are taken in grey; second card shows the earlier outward
  expect((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [3] }] })).body.error.code).toBe('THAAN_NOT_IN_STOCK');
  const c2 = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [2] }] })).body;
  expect(c2.lots[0]).toMatchObject({ outBefore: 180, balanceBefore: 170, meters: 120, balanceAfter: 50 });
  const g = (await api('get', `/grey-lots/${lot.id}`)).body;
  expect(g.thaans.map((t) => t.status)).toEqual(['SO_CARD', 'SO_CARD', 'SO_CARD', 'IN_STOCK']);
  expect((await api('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [2] })).body.error.code).toBe('THAAN_ON_SO_CARD');

  // edit card 2's thaans: thaan 2 goes back, thaan 4 is taken
  const e2 = (await api('patch', `/so-cards/${c2.id}`, { lots: [{ greyLotId: lot.id, thaanNos: [4] }] })).body;
  expect(e2.lots[0]).toMatchObject({ thaanNos: [4], meters: 50 });
  expect((await api('get', `/grey-lots/${lot.id}`)).body.thaans.map((t) => t.status)).toEqual(['SO_CARD', 'IN_STOCK', 'SO_CARD', 'SO_CARD']);

  // two cards to Dyeing together: one job with both SO numbers
  const sent = (await api('post', '/so-cards/send-many', { soCardIds: [c1.id, c2.id], departmentId: s.DYEING.id, sentThrough: 'Akram', workInstructions: 'Dye black, shade 12' })).body;
  expect(sent.job.instructions).toBe('Dye black, shade 12');
  expect(sent.job).toMatchObject({ jobNo: 1, totalMeters: 630, soNos: [c1.cardNo, c2.cardNo] });
  expect(sent.soCards.map((c) => c.status)).toEqual(['SENT', 'SENT']);
  expect((await api('post', '/so-cards/send-many', { soCardIds: [c1.id], departmentId: s.DYEING.id })).body.error.code).toBe('CARD_SENT');

  // filter by SO#, operator typed by the department
  expect((await api('get', `/departments/DYEING/incoming?soNo=${c2.cardNo}`)).body.data.map((j) => j.jobNo)).toEqual([1]);
  const op = (await api('put', `/departments/DYEING/jobs/${sent.job.id}/operator`, { operatorName: 'Rashid' })).body;
  expect(op).toMatchObject({ operatorName: 'Rashid', operatorSetBy: { id: admin.id } });

  // part of a thaan: 30 m of thaan 2 (120 m), then the other 90 m on another card
  const big = await mk(cu.id, { thaans: [2000, 500] });
  const p1 = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: big.id, thaans: [{ thaanNo: 1, meters: 1000 }] }] })).body;
  expect(p1.lots[0]).toMatchObject({ meters: 1000, pieces: 1, thaans: [{ thaanNo: 1, meters: 1000, thaanMeters: 2000, isPart: true }] });
  const avb = (await api('get', `/so-cards/available-lots?customerId=${cu.id}`)).body.data.find((l) => l.id === big.id);
  expect(avb.thaans).toEqual([expect.objectContaining({ thaanNo: 1, meters: 1000, thaanMeters: 2000, takenMeters: 1000 }), expect.objectContaining({ thaanNo: 2, meters: 500 })]);
  expect((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: big.id, thaans: [{ thaanNo: 1, meters: 1500 }] }] })).body.error.code).toBe('THAAN_SHORT');
  expect((await api('post', `/grey-lots/${big.id}/give-back`, { thaanNos: [1] })).body.error.code).toBe('THAAN_ON_SO_CARD');
  await api('post', `/grey-lots/${big.id}/unapprove`);
  expect((await api('patch', `/grey-lots/${big.id}`, { thaans: [1900, 500] })).body.error.code).toBe('THAAN_ON_SO_CARD');
  expect((await api('patch', `/grey-lots/${big.id}`, { thaans: [2000, 600] })).body.inwardMeters).toBe(2600);
  await api('post', `/grey-lots/${big.id}/approve`);
  const p2 = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: big.id, thaanNos: [1] }] })).body;
  expect(p2.lots[0]).toMatchObject({ meters: 1000, thaans: [{ thaanNo: 1, meters: 1000, isPart: true }] });
  expect((await api('get', `/grey-lots/${big.id}`)).body.thaans[0].status).toBe('SO_CARD');
  await api('delete', `/so-cards/${p2.id}`);
  expect((await api('get', `/grey-lots/${big.id}`)).body.thaans[0].status).toBe('IN_STOCK');

  // edit: p1 holds 1000 of thaan 1; the edit screen shows it as free again and ticked
  const ed = (await api('get', `/so-cards/${p1.id}/edit-data`)).body;
  expect(ed).toMatchObject({ canEdit: true, lockedReason: null });
  const eb = ed.lots.find((l) => l.id === big.id);
  expect(eb).toMatchObject({ onThisCard: 1000, selected: true, balanceMeters: 2600 });
  expect(eb.thaans[0]).toMatchObject({ thaanNo: 1, meters: 2000, onThisCard: 1000, selected: true, takenMeters: 0 });
  // change 1000 -> 1500 of thaan 1 and add 200 of thaan 2
  const e1 = (await api('patch', `/so-cards/${p1.id}`, { lots: [{ greyLotId: big.id, thaans: [{ thaanNo: 1, meters: 1500 }, { thaanNo: 2, meters: 200 }] }] })).body;
  expect(e1).toMatchObject({ totalMeters: 1700, totalPieces: 2 });
  let gl = (await api('get', `/grey-lots/${big.id}`)).body;
  expect(gl.thaans.map((t) => t.takenMeters)).toEqual([1500, 200]);
  expect((await api('patch', `/so-cards/${p1.id}`, { lots: [{ greyLotId: big.id, thaans: [{ thaanNo: 1, meters: 2001 }] }] })).body.error.code).toBe('THAAN_SHORT');
  // a confirmed card says so
  await api('put', `/so-cards/${p1.id}/confirm`, { isConfirmed: true });
  expect((await api('get', `/so-cards/${p1.id}/edit-data`)).body).toMatchObject({ canEdit: false, lockedReason: 'CARD_CONFIRMED' });
  await api('put', `/so-cards/${p1.id}/confirm`, { isConfirmed: false });
  await api('delete', `/so-cards/${p1.id}`);
  gl = (await api("get", `/grey-lots/${big.id}`)).body;
  expect(gl.thaans.map((t) => t.takenMeters)).toEqual([0, 0]);

  // cancel frees thaans
  const c3 = (await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [2] }] })).body;
  await api('delete', `/so-cards/${c3.id}`);
  expect((await api('get', `/grey-lots/${lot.id}`)).body.thaans[1].status).toBe('IN_STOCK');
});
