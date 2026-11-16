const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, SoCardMove } = require('../src/models');
const { UniqueConstraintError } = require('sequelize');
const errorHandler = require('../src/middlewares/errorHandler');

jest.setTimeout(240000);
beforeEach(clean);

async function setup() {
  const company = await makeCompany();
  const s = {};
  for (const code of ['GREY_STORE', 'SO_CARD', 'DYEING', 'FOLDING']) {
    s[code] = await Service.findOne({ where: { code } });
    await CompanyService.create({ companyId: company.id, serviceId: s[code].id });
  }
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const cards = [];
  for (let i = 0; i < 2; i += 1) {
    const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [60, 40] })).body;
    await api('post', `/grey-lots/${lot.id}/approve`);
    cards.push((await api('post', '/so-cards', { cardDate: '2026-10-15', lots: [{ greyLotId: lot.id, thaanNos: [1, 2] }] })).body);
  }
  return { company, s, api, cards };
}
const sendMany = (w, ids, dep = 'DYEING') => w.api('post', '/so-cards/send-many', { soCardIds: ids, departmentId: w.s[dep].id });
const ret = (w, jobId, ids, dep = 'DYEING') => w.api('post', `/departments/${dep}/jobs/${jobId}/return-to-so-card`, { soCardIds: ids, reason: 'wrong' });

test('a card sent with send-many, returned to the SO card desk and edited can be sent again (to the same or another department), again and again; the old move is history', async () => {
  const w = await setup();
  const [c1, c2] = w.cards;
  for (let round = 1; round <= 3; round += 1) {
    const sent = await sendMany(w, [c1.id]);
    expect([round, sent.status]).toEqual([round, 201]);
    expect(sent.body.soCards[0]).toMatchObject({ status: 'SENT' });
    const job = sent.body.job;
    // the card has ONE move waiting
    expect((await SoCardMove.count({ where: { soCardId: c1.id, acceptedAt: null, cancelledAt: null } }))).toBe(1);
    const back = await ret(w, job.id, [c1.id]);
    expect(back.status).toBe(200);
    expect(back.body.soCards[0]).toMatchObject({ status: 'NEW', backAtSoCard: true });
    // nothing waits for the department any more; the move stays in the card history, cancelled
    expect(await SoCardMove.count({ where: { soCardId: c1.id, acceptedAt: null, cancelledAt: null } })).toBe(0);
    const card = (await w.api('get', `/so-cards/${c1.id}`)).body;
    expect(card.status).toBe('NEW');
    expect(card.lastMove).toBeNull();
    expect(card.moves).toHaveLength(round);
    expect(card.moves.every((m) => m.cancelledAt)).toBe(true);
    expect((await w.api('get', `/so-cards/incoming?departmentId=${w.s.DYEING.id}`)).body.data.map((c) => c.id)).not.toContain(c1.id);
  }
  // the card is edited meanwhile and goes again, now together with another card
  expect((await w.api('patch', `/so-cards/${c1.id}`, { remarks: 'edited after the return' })).status).toBe(200);
  const both = await sendMany(w, [c1.id, c2.id]);
  expect(both.status).toBe(201);
  expect(both.body.soCards.map((c) => c.status)).toEqual(['SENT', 'SENT']);
  expect((await SoCardMove.count({ where: { soCardId: c1.id, acceptedAt: null, cancelledAt: null } }))).toBe(1);
  // a card that is really on its way still cannot be sent twice
  const twice = await sendMany(w, [c1.id]);
  expect([twice.status, twice.body.error.code]).toEqual([422, 'CARD_SENT']);
});

test('cards that were already stuck (returned before this fix: status NEW with an open move) can be sent again at once', async () => {
  const w = await setup();
  const [c1] = w.cards;
  const first = await sendMany(w, [c1.id]);
  expect(first.status).toBe(201);
  // what the old code left behind: the cloth returned (card NEW), the move still open
  await sequelize.query('UPDATE jobs SET status = \'REJECTED\', "returnedToSoCard" = true WHERE id = :id', { replacements: { id: first.body.job.id } });
  await sequelize.query('UPDATE so_cards SET status = \'NEW\', "currentDepartmentId" = NULL WHERE id = :id', { replacements: { id: c1.id } });
  expect(await SoCardMove.count({ where: { soCardId: c1.id, acceptedAt: null, cancelledAt: null } })).toBe(1);
  const again = await sendMany(w, [c1.id]);
  expect(again.status).toBe(201);
  expect(await SoCardMove.count({ where: { soCardId: c1.id, acceptedAt: null, cancelledAt: null } })).toBe(1);
  expect(await SoCardMove.count({ where: { soCardId: c1.id } })).toBe(2);
  // the single-card send (the desk's "send") heals the same way
  await sequelize.query('UPDATE jobs SET status = \'REJECTED\', "returnedToSoCard" = true WHERE id = :id', { replacements: { id: again.body.job.id } });
  await sequelize.query('UPDATE so_cards SET status = \'NEW\', "currentDepartmentId" = NULL WHERE id = :id', { replacements: { id: c1.id } });
  const single = await w.api('post', `/so-cards/${c1.id}/send`, { departmentId: w.s.DYEING.id });
  expect([single.status, single.body.error && single.body.error.code]).toEqual([200, undefined]);
});

test('the duplicate error says which field / index clashed (details), so it can be traced', () => {
  const err = new UniqueConstraintError({ message: 'x', fields: { soCardId: 'abc' }, parent: { constraint: 'so_card_moves_one_open', table: 'so_card_moves' } });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  errorHandler(err, { log: { warn: jest.fn(), error: jest.fn() }, headers: {} }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: { code: 'DUPLICATE', message: 'A record with the same value already exists', details: { fields: ['soCardId'], constraint: 'so_card_moves_one_open', table: 'so_card_moves' } } });
});
