const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

beforeEach(clean);

test('deleted lots report: the record of a deleted lot (who, why), filters, the missing numbers', async () => {
  const company = await makeCompany();
  for (const code of ['GREY_STORE', 'SO_CARD']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  const api = (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body);
  const cu = (await api('post', '/customers', { code: 130, name: 'AZ' })).body;
  const q = (await api('post', '/qualities', { name: 'PC TWILL' })).body;
  const a = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [100, 50] })).body;
  const b = (await api('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, thaans: [70] })).body;
  expect((await api('get', '/reports/grey/deleted-lots')).body.rows).toHaveLength(0);

  expect((await api('delete', `/grey-lots/${a.id}`, { reason: 'Entered twice' })).status).toBe(204);
  const again = (await api('post', '/grey-lots', { inwardDate: '2026-10-11', customerId: cu.id, qualityId: q.id, thaans: [150] })).body;
  expect(again.lotNo).toBe(b.lotNo + 1); // the number of the deleted lot is never reused

  const r = (await api('get', '/reports/grey/deleted-lots')).body;
  expect(r.columns.map((c) => c.key)).toEqual(['lotNo', 'typeNo', 'inwardDate', 'party', 'quality', 'unit', 'thaans', 'meters', 'dcNo', 'kind', 'reason', 'deletedAt', 'deletedBy']);
  expect(r).toMatchObject({ total: 1, page: 1, limit: 50, totals: { thaans: 2, meters: 150 } });
  expect(r.rows[0]).toMatchObject({ lotNo: a.lotNo, party: 'AZ', quality: 'PC TWILL', unit: 'METER', thaans: 2, meters: 150, kind: 'Deleted', reason: 'Entered twice', source: 'MANUAL' });
  expect(r.rows[0].deletedBy).toBeTruthy();
  expect((await api('get', `/reports/grey/deleted-lots?search=${a.lotNo}`)).body.rows).toHaveLength(1);
  expect((await api('get', '/reports/grey/deleted-lots?search=zzzz')).body.rows).toHaveLength(0);
  expect((await api('get', '/reports/grey/deleted-lots?dateFrom=2030-01-01')).body.rows).toHaveLength(0);
  expect((await api('get', `/reports/grey/deleted-lots?customerId=${cu.id}&qualityId=${q.id}`)).body.rows).toHaveLength(1);

  // it is listed in the Reports menu
  const menu = (await api('get', '/reports')).body.reports.find((x) => x.key === 'grey-deleted-lots');
  expect(menu).toMatchObject({ url: '/v1/reports/grey/deleted-lots' });

  // the gaps: delete the newest-but-one lot number so a hole shows; lot numbers that exist only deleted are listed as records
  const gaps = (await api('get', '/reports/grey/lot-gaps')).body;
  expect(gaps.rows.map((x) => [x.lotNo, x.status])).toEqual([[a.lotNo, 'Deleted lot']]);
});
