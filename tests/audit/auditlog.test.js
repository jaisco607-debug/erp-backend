// AUDIT: the audit log. Every successful change must leave a record (who, what, when), and the log must not hold secrets.
const { world, clean, sequelize } = require('./world');
const { seedEverything } = require('./seed');

beforeEach(clean);
jest.setTimeout(600000);

test('every successful changing call writes at least one audit row', async () => {
  const w = await world();
  w.track = [];
  const ids = await seedEverything(w);
  // more changes: edits, switches, deletes
  await w.api('patch', `/customers/${ids.customer}`, { phone: '0300' });
  await w.api('patch', `/colours/${ids.colour}`, { name: 'NAVY 2' });
  await w.api('put', `/grey-lots/${ids.lot2}/active`, { isActive: false });
  await w.api('put', `/so-cards/${ids.card2}/confirm`, { isConfirmed: true });
  await w.api('patch', `/users/${ids.employee}`, { name: 'Aslam K' });
  await w.api('put', `/users/${ids.employee}/services`, { services: [] });
  await w.api('post', `/users/${ids.employee}/reset-password`, { newPassword: 'Brand-New-Pass-1' });
  await w.api('post', '/stores/chemical/categories', { name: 'X' });
  await w.api('post', '/vendors', { name: 'V3' });
  await w.api('put', '/stores/chemical/department-access/DYEING', { remove: [ids.item] });
  await w.api('put', '/so-cards/numbering', { nextCardNo: 500 });
  await w.api('put', '/grey-lots/numbering', { nextLotNo: 900 });
  const silent = w.track.filter((t) => t.status < 300 && t.audit === 0);
  console.log(`changing calls: ${w.track.length}, without any audit row: ${silent.length}\n` + silent.map((t) => `  ${t.method.toUpperCase()} ${t.url.replace(/[0-9a-f-]{36}/g, ':id')} -> ${t.status}`).join('\n'));
  expect(silent.map((t) => `${t.method.toUpperCase()} ${t.url.replace(/[0-9a-f-]{36}/g, ':id')}`)).toEqual([]);
});

test('the audit log holds no password, hash or token', async () => {
  const w = await world();
  await seedEverything(w);
  await w.api('post', `/users/${(await w.ok('get', '/users')).data[0].id}/reset-password`, { newPassword: 'Brand-New-Pass-1' });
  const rows = await sequelize.query('SELECT action, "actorEmail", before::text AS b, after::text AS a FROM audit_logs', { type: sequelize.QueryTypes.SELECT });
  const text = rows.map((r) => `${r.b}${r.a}`).join('\n');
  expect(text).not.toMatch(/passwordHash|\$2[aby]\$|Brand-New-Pass|Employee-Pass|accessToken|refreshToken|Strong-Pass/);
  expect(rows.length).toBeGreaterThan(40);
});

test('the audit log cannot be changed or deleted, not even by the app user', async () => {
  const w = await world();
  await w.customer('XX');
  await expect(sequelize.query('DELETE FROM audit_logs')).rejects.toThrow();
  await expect(sequelize.query("UPDATE audit_logs SET action = 'HACKED'")).rejects.toThrow();
  await expect(sequelize.query('TRUNCATE audit_logs')).rejects.toThrow();
});
