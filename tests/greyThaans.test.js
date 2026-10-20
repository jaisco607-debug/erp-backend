const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

test('grey lot thaan-wise in yards, totals in meters and yards, give back thaans, undo', async () => {
  const company = await makeCompany();
  for (const code of ['GREY_STORE', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { name: 'AZ TEXTILES' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;

  const lot = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, unit: 'YARD', thaans: [100, 100, 50, 50], glm: 145.5, gsm: 120 })).body;
  expect(lot).toMatchObject({ glm: 145.5, gsm: 120, unit: 'YARD', pieces: 4, inwardYards: 300, inwardMeters: 274.32, balanceYards: 300 });
  expect(lot.thaans.map((t) => [t.thaanNo, t.meters, t.yards, t.status])).toEqual([[1, 91.44, 100, 'IN_STOCK'], [2, 91.44, 100, 'IN_STOCK'], [3, 45.72, 50, 'IN_STOCK'], [4, 45.72, 50, 'IN_STOCK']]);

  // plain meters lot (no thaan list) still works
  const plain = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, inwardMeters: 1000, pieces: 10 })).body;
  expect(plain).toMatchObject({ unit: 'METER', showYards: false, inwardMeters: 1000, inwardYards: null, thaans: [] });
  expect((await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id })).body.error.code).toBe('QTY_REQUIRED');

  // edit the thaan list
  const edited = (await api('patch', `/grey-lots/${lot.id}`, { thaans: [100, 100, 50, 50, 25] })).body;
  expect(edited).toMatchObject({ pieces: 5, inwardYards: 325 });
  expect((await api('patch', `/grey-lots/${lot.id}`, { gsm: 130, glm: null })).body).toMatchObject({ gsm: 130, glm: null });

  // party wants thaans 3 and 4 back unprocessed
  const back = (await api('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [3, 4], returnDate: '2026-10-15', vehicleNo: 'LES-1' })).body;
  expect(back).toMatchObject({ returnedPieces: 2, returnedMeters: 91.44, balanceYards: 225, soCardMeters: 0 });
  expect(back.returns[0]).toMatchObject({ returnNo: 1, pieces: 2, yards: 100 });
  expect(back.thaans.filter((t) => t.status === 'RETURNED').map((t) => t.thaanNo)).toEqual([3, 4]);
  expect((await api('post', `/grey-lots/${lot.id}/give-back`, { thaanNos: [3] })).body.error.code).toBe('THAAN_RETURNED');
  expect((await api('patch', `/grey-lots/${lot.id}`, { thaans: [200, 100, 50] })).body.error.code).toBe('THAAN_RETURNED');
  // other thaans can still change while the given-back ones stay
  expect((await api('patch', `/grey-lots/${lot.id}`, { thaans: [90, 100, 50, 50, 25], typeNo: '9001' })).body).toMatchObject({ typeNo: '9001', inwardYards: 315, returnedPieces: 2 });
  expect((await api('post', `/grey-lots/${plain.id}/give-back`, { meters: 2000 })).body.error.code).toBe('NOT_ENOUGH_METERS');
  expect((await api('post', `/grey-lots/${plain.id}/give-back`, { meters: 400, pieces: 4 })).body).toMatchObject({ balanceMeters: 600 });

  // quality typed by hand (existing one reused, new one added) and lot# typed by hand
  const typed = (await api('post', '/grey-lots', { lotNo: 500, inwardDate: '2026-10-15', customerId: cu.id, qualityName: 'pc twill', thaans: [10] })).body;
  expect(typed).toMatchObject({ lotNo: 500, quality: { id: q.id } });
  const newQ = (await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, qualityName: 'CVC 60/40', thaans: [10] })).body;
  expect(newQ).toMatchObject({ lotNo: 501, quality: { name: 'CVC 60/40' } });
  expect((await api('post', '/grey-lots', { lotNo: 500, inwardDate: '2026-10-15', customerId: cu.id, qualityId: q.id, thaans: [10] })).body.error.code).toBe('LOT_NO_TAKEN');
  expect((await api('post', '/grey-lots', { inwardDate: '2026-10-15', customerId: cu.id, thaans: [10] })).status).toBe(400);
  expect((await api('patch', `/grey-lots/${newQ.id}`, { lotNo: 502 })).body.lotNo).toBe(502);

  const undone = (await api('delete', `/grey-lots/${lot.id}/give-back/${back.returns[0].id}`)).body;
  expect(undone).toMatchObject({ returnedPieces: 0, balanceYards: 315, returns: [] });
});
