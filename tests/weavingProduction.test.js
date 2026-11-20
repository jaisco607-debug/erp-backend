const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, YarnBeam } = require('../src/models');
const { unitsToMeters } = require('../src/utils/loomUnits');

jest.setTimeout(240000);
beforeEach(clean);

const call = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const err = (r, status, code) => { expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const insertEmployee = (companyId, groupId, departmentId, code, name) => sequelize.query(
  `INSERT INTO payroll_employees (id, "companyId", code, name, "groupId", "departmentId", "joiningDate", status, "confirmedAt") VALUES (gen_random_uuid(), :companyId, :code, :name, :groupId, :departmentId, '2025-01-01', 'CONFIRMED', now())`,
  { replacements: { companyId, code, name, groupId, departmentId } });

async function setup() {
  const company = await makeCompany();
  for (const code of ['WEAVING_MASTERS', 'SIZING', 'WEAVING_PRODUCTION', 'PAYROLL_EMPLOYEES']) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const viewer = await makeUser({ userType: 'USER', companyId: company.id });
  await UserService.create({ userId: viewer.id, serviceId: (await Service.findOne({ where: { code: 'WEAVING_PRODUCTION' } })).id, access: 'VIEW' });
  const api = call(admin);
  const sulzer = (await api('post', '/weaving/departments', { name: 'Sulzer' })).body;
  const airjet = (await api('post', '/weaving/departments', { name: 'Airjet' })).body;
  const looms = {};
  for (const no of ['01', '02', '03']) looms[no] = (await api('post', '/weaving/looms', { loomNo: no, departmentId: sulzer.id })).body;
  const other = (await api('post', '/weaving/looms', { loomNo: '101', departmentId: airjet.id })).body;
  // payroll: weaving employees and one from another department
  const [factory] = (await api('get', '/payroll/groups')).body.data;
  const weaving = (await api('post', '/payroll/departments', { groupId: factory.id, name: 'Weaving', fte: 10 })).body;
  const stitching = (await api('post', '/payroll/departments', { groupId: factory.id, name: 'Stitching', fte: 10 })).body;
  await insertEmployee(company.id, factory.id, weaving.id, 129, 'ALI KHAN');
  await insertEmployee(company.id, factory.id, weaving.id, 261, 'BILAL RABI');
  await insertEmployee(company.id, factory.id, stitching.id, 500, 'ZED STITCHER');
  const emps = (await api('get', '/production/weavers/employees?departmentId=' + sulzer.id + '&date=2026-11-16')).body.data;
  // two full beams of 4,100 m on loom 01: K-ID 1, confirmed, pick 56
  const beams = [];
  for (let i = 1; i <= 2; i += 1) beams.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  await YarnBeam.update({ status: 'FULL', meters: 4100, statusDate: '2026-11-01' }, { where: { id: beams.map((b) => b.id) } });
  const entry = (await api('post', '/sizing/loom-beams', { loomId: looms['01'].id, beamIds: beams.map((b) => b.id), loomRpm: 400, loomPick: 56, reedSpace: 63, startDate: '2026-11-10' })).body;
  const conf = await api('post', `/sizing/loom-beams/${entry.id}/confirm`);
  if (conf.status !== 200) throw new Error(JSON.stringify([entry, conf.body]));
  // loom 02 runs K-ID 2 too (loom 03 stays empty: no beam, so it is not offered for production)
  const beams2 = [];
  for (let i = 3; i <= 4; i += 1) beams2.push((await api('post', '/weaving/beams', { name: `S${i}`, beamDate: '2026-10-01' })).body);
  await YarnBeam.update({ status: 'FULL', meters: 4100, statusDate: '2026-11-01' }, { where: { id: beams2.map((b) => b.id) } });
  const entry2 = (await api('post', '/sizing/loom-beams', { loomId: looms['02'].id, beamIds: beams2.map((b) => b.id), loomRpm: 400, loomPick: 56, reedSpace: 63, startDate: '2026-11-10' })).body;
  await api('post', `/sizing/loom-beams/${entry2.id}/confirm`);
  return { api, viewer: call(viewer), sulzer, airjet, looms, other, emps, entry, companyId: company.id };
}

test('units to metres: 1 unit = 1,000 picks', () => {
  expect(unitsToMeters(1114, 56)).toBe(505.28); // the figure of the K-ID 304 screen: 505 m
  expect(unitsToMeters(1114, null)).toBeNull();
});

test('weavers of the day: only payroll weaving employees, looms per weaver, one weaver per loom and shift, copy', async () => {
  const w = await setup();
  expect(w.emps.map((e) => e.code)).toEqual([129, 261]); // not the stitching employee
  const day = '2026-11-16';
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body;
  expect(ali.added).toBe(1);
  const aliRow = ali.shifts.A.weavers[0];
  err(await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: ['6f1c2f4e-3b0a-4c9c-9a53-0a4d0b7e9d11'] }), 422, 'NOT_A_WEAVER');
  err(await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: '2030-01-01', shift: 'A', employeeIds: [w.emps[0].id] }), 422, 'FUTURE_DATE');
  const set = await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id] });
  expect(set.body).toMatchObject({ loomsText: '01, 02', loomCount: 2, shift: 'A' });
  err(await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.other.id] }), 422, 'UNKNOWN_LOOM'); // a loom of another department
  err(await w.api('put', `/production/weavers/${aliRow.id}/looms`, { loomIds: [w.looms['03'].id] }), 422, 'LOOM_EMPTY'); // no beam on loom 03
  const bilal = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[1].id] })).body.shifts.A.weavers.find((x) => x.employee.code === 261);
  err(await w.api('put', `/production/weavers/${bilal.id}/looms`, { loomIds: [w.looms['02'].id] }), 422, 'LOOM_TAKEN');
  expect((await w.api('put', `/production/weavers/${bilal.id}/looms`, { loomIds: [w.looms['02'].id], move: true })).body.loomsText).toBe('02');
  const d = (await w.api('get', `/production/weavers?departmentId=${w.sulzer.id}&date=${day}`)).body;
  expect(d).toMatchObject({ totals: { weavers: 2, looms: 2 } });
  expect(d.looms.map((l) => l.loomNo)).toEqual(['01', '02']); // only looms with a running beam
  expect(d.shifts.A.weavers.map((x) => [x.employee.code, x.loomsText])).toEqual([[129, '01'], [261, '02']]);
  // copy to another day: shifts that have no weavers there yet
  const c = (await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-17' })).body;
  expect(c.copied).toEqual({ A: 2, B: 0, C: 0 });
  expect((await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-17' })).body.skippedShifts).toEqual(['A']);
  // before the K-ID started the looms have no beam: the weavers are copied, the looms are not
  const early = (await w.api('post', '/production/weavers/copy', { departmentId: w.sulzer.id, fromDate: day, toDate: '2026-11-05' })).body;
  expect(early).toMatchObject({ copied: { A: 2, B: 0, C: 0 }, emptyLooms: ['01', '02'], totals: { weavers: 2, looms: 0 } });
  // remove
  expect((await w.api('post', '/production/weavers/remove', { ids: [bilal.id] })).body.removed).toBe(1);
  expect((await w.viewer('get', `/production/weavers?departmentId=${w.sulzer.id}&date=${day}`)).body.totals.weavers).toBe(1);
  expect((await w.viewer('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).status).toBe(403);
});

test('units: day register, K-ID, checks, the cloth made on the K-ID, periods, CSV uploads', async () => {
  const w = await setup();
  const day = '2026-11-16';
  const ali = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'A', employeeIds: [w.emps[0].id] })).body.shifts.A.weavers[0];
  await w.api('put', `/production/weavers/${ali.id}/looms`, { loomIds: [w.looms['01'].id, w.looms['02'].id] });
  const save = await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [
    { loomId: w.looms['01'].id, shift: 'A', units: 79 }, { loomId: w.looms['01'].id, shift: 'B', units: 96 }, { loomId: w.looms['01'].id, shift: 'C', units: 107 }, { loomId: w.looms['02'].id, shift: 'A', units: 91 }] });
  expect(save.status).toBe(200);
  const r1 = save.body.rows.find((r) => r.loomNo === '01');
  expect(r1).toMatchObject({ kId: 1, pick: 56, totalUnits: 282 });
  expect(r1.shifts.A).toMatchObject({ units: 79, weaver: { code: 129, name: 'ALI KHAN' } });
  expect(r1.shifts.B.weaver).toBeNull();
  expect(save.body.rows.map((r) => r.loomNo)).toEqual(['01', '02']); // only looms with a beam; empty loom 03 and the other department's loom are not here
  expect(save.body.totals).toEqual({ A: 170, B: 96, C: 107, total: 373 });
  // the checks: units with no weaver (problem), units on a loom with no K-ID (warning)
  const codes = save.body.check.items.map((c) => c.code).sort();
  expect(codes).toEqual(['UNITS_NO_WEAVER', 'UNITS_NO_WEAVER']);
  expect(save.body.check).toMatchObject({ problems: 2, warnings: 0 });
  err(await w.api('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [{ loomId: w.other.id, shift: 'A', units: 5 }] }), 422, 'UNKNOWN_LOOM');
  // a weaver in two shifts is a problem
  const ali2 = (await w.api('post', '/production/weavers', { departmentId: w.sulzer.id, date: day, shift: 'B', employeeIds: [w.emps[0].id] })).body.shifts.B.weavers[0];
  await w.api('put', `/production/weavers/${ali2.id}/looms`, { loomIds: [w.looms['02'].id] });
  const ck = (await w.api('get', `/production/day/check?departmentId=${w.sulzer.id}&date=${day}`)).body;
  expect(ck.items.map((c) => c.code)).toEqual(expect.arrayContaining(['WEAVER_LOOMS_TWO_SHIFTS', 'WEAVER_TWO_SHIFTS']));

  // the K-ID screen: units, cloth made, balance
  const e = (await w.api('get', `/sizing/loom-beams/${w.entry.id}`)).body;
  const made = unitsToMeters(282, 56);
  expect(e).toMatchObject({ units: 282, producedM: made, balanceM: Math.round((4100 - made) * 100) / 100, daysRun: 1, lastProductionDate: day, netLengthM: 4100 });
  expect(e.donePct).toBeGreaterThan(3);
  const reg = (await w.api('get', `/sizing/loom-beams/${w.entry.id}/production`)).body;
  expect(reg).toMatchObject({ kId: 1, totalUnits: 282, producedM: made });
  expect(reg.data.map((x) => [x.date, x.shift, x.units])).toEqual([[day, 'A', 79], [day, 'B', 96], [day, 'C', 107]]);
  expect(reg.data[0].weaver).toMatchObject({ code: 129 });

  // periods of 15 days
  const ps = (await w.api('get', `/production/periods?departmentId=${w.sulzer.id}`)).body;
  expect(ps.data[0]).toMatchObject({ from: '2026-11-16', to: '2026-11-30', days: 15, daysWithUnits: 1, totalUnits: 373, isCurrent: true });
  const p = (await w.api('get', `/production/period?departmentId=${w.sulzer.id}&from=2026-11-16`)).body;
  expect(p).toMatchObject({ label: '16-30 Nov-26', dayCount: 15, totalUnits: 373, shiftTotals: { A: 170, B: 96, C: 107 }, daysWithUnits: 1, daysWithoutUnits: 14, averagePerDay: 373, bestDay: { date: day, units: 373 } });
  expect(p.noWeaver.count).toBe(2);
  expect(p.days[0]).toMatchObject({ date: day, weekday: 'Mon', registerLooms: 2, totalUnits: 373 });
  err(await w.api('get', `/production/period?departmentId=${w.sulzer.id}&from=2026-11-17`), 422, 'BAD_PERIOD');

  // CSV upload of units: good rows are saved, bad rows reported with their line
  const csv = 'date,shift,loom_no,units,k_id\n2026-11-17,A,1,50,1\n2026-11-17,B,02,60,\n2026-11-17,Z,01,5,\n2026-11-17,A,09,5,\n2026-11-17,C,01,70,5\n2026-11-17,A,03,9,\n';
  const up = (await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, csv })).body;
  expect(up).toMatchObject({ saved: 2, skipped: 4, dates: ['2026-11-17'] });
  expect(up.errors.map((x) => x.line)).toEqual([4, 5, 6, 7]); // 7 = the empty loom 03
  expect((await w.api('get', `/production/day?departmentId=${w.sulzer.id}&date=2026-11-17`)).body.totals.total).toBe(110);
  err(await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, csv: 'a,b\n1,2\n' }), 422, 'BAD_FILE');
  // the same rows as JSON
  expect((await w.api('post', '/production/units/import', { departmentId: w.sulzer.id, rows: [{ date: '2026-11-18', shift: 'A', loom_no: '01', units: 40 }] })).body.saved).toBe(1);
  // CSV upload of the weavers with their looms
  const wcsv = 'date,shift,employee_id,looms\n2026-11-18,A,129,1 2\n2026-11-18,B,261,"1;2"\n2026-11-18,A,500,2\n2026-11-18,C,129,3\n';
  const wu = (await w.api('post', '/production/weavers/import', { departmentId: w.sulzer.id, csv: wcsv })).body;
  expect(wu).toMatchObject({ saved: 2, withLooms: 2, skipped: 2 }); // the stitching employee, and the empty loom 03
  const d18 = (await w.api('get', `/production/weavers?departmentId=${w.sulzer.id}&date=2026-11-18`)).body;
  expect(d18.shifts.A.weavers[0]).toMatchObject({ loomsText: '01, 02' });
  expect(d18.shifts.B.weavers[0]).toMatchObject({ loomsText: '01, 02' });
  expect((await w.api('get', `/production/day?departmentId=${w.sulzer.id}&date=2026-11-18`)).body.rows[0].shifts.A.weaver.code).toBe(129);
  // samples and the export
  const s = await w.api('get', '/production/units/sample.csv');
  expect([s.status, s.headers['content-type']]).toEqual([200, 'text/csv; charset=utf-8']);
  expect((await w.api('get', '/production/weavers/sample.csv')).text).toContain('employee_id');
  expect((await w.api('get', `/production/day/csv?departmentId=${w.sulzer.id}&date=${day}`)).text).toContain('2026-11-16,A,01,129,ALI KHAN,79,1');
  // delete ticked; the loom cannot be deleted while it is in the register
  expect((await w.api('post', '/production/day/clear', { departmentId: w.sulzer.id, date: day, loomIds: [w.looms['02'].id] })).body.totals.A).toBe(79);
  err(await w.api('delete', `/weaving/looms/${w.looms['02'].id}`), 422, 'IN_USE');
  expect((await w.viewer('put', '/production/day', { departmentId: w.sulzer.id, date: day, rows: [{ loomId: w.looms['01'].id, shift: 'A', units: 1 }] })).status).toBe(403);
});
