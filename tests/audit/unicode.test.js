// AUDIT: Urdu / Arabic / emoji in names and searches (the mill works in Urdu). Needs a UTF8 database (the real one is UTF8).
const { world, clean, expectClean } = require('./world');

beforeEach(clean);
jest.setTimeout(300000);

test('Urdu and emoji names can be saved, shown and searched in every master and list', async () => {
  const w = await world();
  const urdu = 'علی ٹیکسٹائل';
  const cu = await w.ok('post', '/customers', { name: urdu }, 201);
  expect(cu.name).toBe(urdu);
  const q = await w.ok('post', '/qualities', { name: 'کینوس ٹوئل' }, 201);
  await w.ok('post', '/colours', { name: 'نیلا' }, 201);
  await w.ok('post', '/vendors', { name: 'علی کیمیکل' }, 201);
  const red = await w.ok('post', '/stores/chemical/items', { name: 'سرخ رنگ 😀', unit: 'KG' }, 201);
  await w.ok('post', '/grey-lots', { inwardDate: '2026-10-10', customerId: cu.id, qualityId: q.id, inwardMeters: 100, pieces: 1, remarks: 'خراب مال نہیں' }, 201);
  const enc = encodeURIComponent;
  for (const [url, term] of [['/customers', 'علی'], ['/qualities', 'ٹوئل'], ['/colours', 'نیلا'], ['/vendors', 'کیمیکل'], ['/stores/chemical/items', '😀'], ['/grey-lots', 'ٹیکسٹائل'], ['/so-cards', 'علی'], ['/stores/chemical/stock', 'سرخ'], ['/reports/grey/lots', 'علی'], ['/reports/so-cards', 'علی'], ['/departments/DYEING/incoming', 'علی']]) {
    const res = await w.api('get', `${url}?search=${enc(term)}`);
    expect([url, res.status]).toEqual([url, 200]);
  }
  expect((await w.ok('get', `/customers?search=${enc('ٹیکسٹائل')}`)).total).toBe(1);
  expect((await w.ok('get', `/grey-lots?search=${enc('ٹیکسٹائل')}`)).total).toBe(1);
  expect((await w.ok('get', `/stores/chemical/items?search=${enc('سرخ')}`)).total).toBe(1);
  // the same name in another letter case / spelling is not a duplicate trick
  expect((await w.api('post', '/customers', { name: urdu })).status).toBeGreaterThanOrEqual(400);
  // the reports carry the Urdu text unchanged
  const parties = await w.ok('get', '/reports/grey/parties');
  expect(parties.rows[0].customer).toBe(urdu);
  expect(red.name).toBe('سرخ رنگ 😀');
  await expectClean();
});
