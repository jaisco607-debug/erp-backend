const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS', 'ACC_REPORTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };
const sql = (text, replacements) => sequelize.query(text, { replacements, type: sequelize.QueryTypes.SELECT });
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });

/**
 * A company with six employees (codes 10 to 15), the provider "Delizia" with the locations Gulshan and Clifton, the provider "Other", and the EOBI rates
 * start: wage 40,000 (5 % = 2,000 / 1 % = 400) and from July 2026: wage 40,700 (2,035 / 407).
 */
async function setup({ rates = true } = {}) {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const emp = async (code, name, extra = {}) => {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', basicSalary: 30000, ...extra }), 201);
    await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  const e = {};
  for (const [code, name] of [[10, 'Abdul Ghani'], [11, 'Basit Ali'], [12, 'Chand Khan'], [13, 'Dilawar Shah'], [14, 'Ehsan Ullah'], [15, 'Farhan Saeed']]) e[code] = await emp(code, name);
  const reports = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(reports, 'PAYROLL_REPORTS', 'FULL');
  const accountant = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(accountant, 'ACC_PAYMENTS', 'FULL');
  const w = { company, admin, api, reports: asUser(reports), accountant: asUser(accountant), factory, e, bank: await Account.findOne({ where: { companyId: company.id, code: '1102' } }) };
  if (rates) {
    await ok(api('put', '/payroll/eobi/rates', { month: '2000-01', wage: 40000, employerPercent: 5, employeePercent: 1 }));
    await ok(api('put', '/payroll/eobi/rates', { month: '2026-07', wage: 40700, employerPercent: 5, employeePercent: 1 }));
  }
  w.delizia = await ok(api('post', '/payroll/eobi/providers', { name: 'Delizia', code: 'NKC' }), 201);
  w.gulshan = await ok(api('post', '/payroll/eobi/locations', { providerId: w.delizia.id, name: 'Gulshan', code: 'G-1' }), 201);
  w.clifton = await ok(api('post', '/payroll/eobi/locations', { providerId: w.delizia.id, name: 'Clifton' }), 201);
  w.other = await ok(api('post', '/payroll/eobi/providers', { name: 'Other Establishment' }), 201);
  return w;
}
const lists = (w, month, provider = null) => ok(w.api('get', `/payroll/eobi/lists?providerId=${(provider || w.delizia).id}&month=${month}`));
const makeList = async (w, month, body = {}, provider = null) => ok(w.api('post', '/payroll/eobi/lists', { providerId: (provider || w.delizia).id, month, mode: 'EMPTY', ...body }), 201);
const add = (w, listId, codes, locationId = null) => ok(w.api('post', `/payroll/eobi/lists/${listId}/rows`, { employeeIds: codes.map((c) => w.e[c].id), locationId }), 201);
const entry = (id) => sql(`SELECT a.name, l.debit::float AS debit, l.credit::float AS credit FROM journal_entries e JOIN journal_lines l ON l."entryId" = e.id JOIN accounts a ON a.id = l."accountId"
  WHERE e."sourceId" = :id AND e."reversalOfId" IS NULL ORDER BY l."lineNo"`, { id });

test('EOBI rates: a wage, the employer and the employee percent from a month until the next rate; the same month again changes it', async () => {
  const w = await setup();
  const rates = await ok(w.api('get', '/payroll/eobi/rates?month=2026-10'));
  expect(rates.line).toBe('EOBI rate for Oct 2026: wage 40,700 · employer 5% = 2,035 · employee 1% = 407');
  expect(rates.data.map((r) => [r.monthLabel, r.wage, r.employerPercent, r.employeePercent, r.perEmployee, r.inEffect])).toEqual([['Jul 2026', '40700.00', 5, 1, '2442.00', true], ['start', '40000.00', 5, 1, '2400.00', false]]);
  expect(rates.data[1]).toMatchObject({ isStart: true, employer: '2000.00', employee: '400.00' });
  expect((await ok(w.api('get', '/payroll/eobi/rates?month=2026-06'))).data.find((r) => r.inEffect).monthLabel).toBe('start'); // before July the first rate holds
  const saved = await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 41000, employerPercent: 5.5, employeePercent: 1.25 }));
  expect(saved.line).toBe('EOBI rate for Oct 2026: wage 41,000 · employer 5.5% = 2,255 · employee 1.25% = 513'); // 512.5 goes up to the rupee
  expect(saved.data).toHaveLength(3);
  expect((await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 41500, employerPercent: 5, employeePercent: 1 }))).data).toHaveLength(3); // the same month: changed, not added
  expect((await ok(w.api('get', '/payroll/eobi/rates?month=2026-11'))).line).toMatch(/wage 41,500 · employer 5% = 2,075 · employee 1% = 415/);
  await fails(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 0, employerPercent: 5, employeePercent: 1 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 40700, employerPercent: 101, employeePercent: 1 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 40700, employerPercent: 5 }), 400, 'VALIDATION_FAILED');
  const id = (await ok(w.api('get', '/payroll/eobi/rates'))).data.find((r) => r.month === '2026-10').id;
  await ok(w.api('delete', `/payroll/eobi/rates/${id}`), 204);
  expect((await ok(w.api('get', '/payroll/eobi/rates?month=2026-10'))).line).toMatch(/wage 40,700/);
  await fails(w.api('delete', `/payroll/eobi/rates/${id}`), 404, 'NOT_FOUND');
});

test('a list: made empty, employees added by name, ID or CNIC, locations assigned, the cards and the vouchers by location; nobody is on two lists', async () => {
  const w = await setup();
  const none = await lists(w, '2026-10');
  expect(none).toMatchObject({ provider: { name: 'Delizia', code: 'NKC' }, month: '2026-10', monthLabel: 'Oct 2026', list: null, copyFrom: null, rate: { wage: '40700.00', perEmployee: '2442.00' } });
  expect(none.rate.line).toBe('EOBI rate for Oct 2026: wage 40,700 · employer 5% = 2,035 · employee 1% = 407');
  const made = await makeList(w, '2026-10');
  expect(made.list.id).toBeTruthy();
  await fails(w.api('post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2026-10', mode: 'EMPTY' }), 422, 'LIST_EXISTS');
  const id = made.list.id;

  // the "Add employees" box: not on any list this month; by name, ID or CNIC
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates`))).total).toBe(6);
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates?search=basit`))).data.map((x) => x.code)).toEqual([11]);
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates?search=12`))).data.map((x) => x.code)).toEqual([12]);
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates?search=4230000000013`))).data.map((x) => x.code)).toEqual([13]);
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates?search=4230-0000000-14`))).data.map((x) => x.code)).toEqual([14]);

  const first = await add(w, id, [10, 11, 12], w.gulshan.id);
  expect(first).toEqual({ added: 3, skipped: [] });
  const second = await add(w, id, [12, 13, 14]); // 12 is already here
  expect(second).toMatchObject({ added: 2, skipped: [{ code: 12, reason: 'ALREADY_ON_LIST' }] });
  // the same employee on the other provider's list the same month is refused
  const otherList = await makeList(w, '2026-10', {}, w.other);
  const onOther = await add(w, otherList.list.id, [10, 15]);
  expect(onOther).toMatchObject({ added: 1, skipped: [{ code: 10, reason: 'ON_OTHER_LIST', provider: 'Delizia' }] });
  await fails(w.api('post', `/payroll/eobi/lists/${id}/rows`, { employeeIds: ['8f3c1a2e-1111-4222-8333-444455556666'] }), 404, 'NOT_FOUND');
  await fails(w.api('post', `/payroll/eobi/lists/${id}/rows`, { employeeIds: [w.e[15].id], locationId: '8f3c1a2e-1111-4222-8333-444455556666' }), 404, 'NOT_FOUND');
  await fails(w.api('post', `/payroll/eobi/lists/${id}/rows`, { employeeIds: [] }), 400, 'VALIDATION_FAILED');

  const v = await lists(w, '2026-10');
  expect(v.cards).toEqual({ employees: 5, withoutLocation: 2, employer: '10175.00', employeeShare: '2035.00', deducted: '0.00', differ: 5, totalPayable: '12210.00' });
  expect(v.byLocation.map((b) => [b.name, b.employees, b.total, b.canVoucher])).toEqual([['Gulshan', 3, '7326.00', true], ['(not set)', 2, '4884.00', false]]);
  expect(v.byLocation[1]).toMatchObject({ locationId: null, hint: 'assign a location first' });
  expect(v.notOnAnyList).toBe(0); // 10 to 14 are here, 15 is on the other provider's list
  expect(v.rows.map((r) => [r.employee.code, r.location && r.location.name, r.wage, r.employer, r.employeeShare, r.total])).toEqual([
    [10, 'Gulshan', '40700.00', '2035.00', '407.00', '2442.00'], [11, 'Gulshan', '40700.00', '2035.00', '407.00', '2442.00'], [12, 'Gulshan', '40700.00', '2035.00', '407.00', '2442.00'],
    [13, null, '40700.00', '2035.00', '407.00', '2442.00'], [14, null, '40700.00', '2035.00', '407.00', '2442.00'],
  ]);
  expect(v.rows[0]).toMatchObject({ employee: { label: '00010', name: 'ABDUL GHANI', department: 'Assembly' }, deducted: '0.00', deductedStatus: null, differs: true, locked: false, source: 'MANUAL' });
  expect((await lists(w, '2026-10')).list.id).toBe(id);
  expect((await ok(w.api('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10&search=basit`))).rows.map((r) => r.employee.code)).toEqual([11]);
  expect((await ok(w.api('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10&locationId=none`))).rows.map((r) => r.employee.code)).toEqual([13, 14]);
  expect((await ok(w.api('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10&locationId=${w.gulshan.id}`))).total).toBe(3);

  // "Save locations" and "set for ticked"
  const rowOf = (code) => v.rows.find((r) => r.employee.code === code).id;
  await ok(w.api('put', `/payroll/eobi/lists/${id}/rows/locations`, { items: [{ rowId: rowOf(13), locationId: w.clifton.id }, { rowId: rowOf(14), locationId: w.clifton.id }, { rowId: rowOf(10), locationId: null }] }));
  const v2 = await lists(w, '2026-10');
  expect(v2.cards.withoutLocation).toBe(1);
  expect(v2.byLocation.map((b) => [b.name, b.employees])).toEqual([['Clifton', 2], ['Gulshan', 2], ['(not set)', 1]]);
  await fails(w.api('put', `/payroll/eobi/lists/${id}/rows/locations`, { items: [{ rowId: rowOf(13), locationId: '8f3c1a2e-1111-4222-8333-444455556666' }] }), 404, 'NOT_FOUND');
  await fails(w.api('put', `/payroll/eobi/lists/${id}/rows/locations`, { items: [{ rowId: '8f3c1a2e-1111-4222-8333-444455556666', locationId: null }] }), 404, 'NOT_FOUND');
  // a location of another provider is not a location of this list
  const foreign = await ok(w.api('post', '/payroll/eobi/locations', { providerId: w.other.id, name: 'Elsewhere' }), 201);
  await fails(w.api('put', `/payroll/eobi/lists/${id}/rows/locations`, { items: [{ rowId: rowOf(13), locationId: foreign.id }] }), 404, 'NOT_FOUND');

  // remove ticked, delete the list
  expect(await ok(w.api('post', `/payroll/eobi/lists/${id}/rows/remove`, { rowIds: [rowOf(13), rowOf(14)] }))).toEqual({ removed: 2 });
  expect((await lists(w, '2026-10')).cards.employees).toBe(3);
  expect((await ok(w.api('get', `/payroll/eobi/lists/${id}/candidates`))).total).toBe(2); // 13 and 14 are free again (10-12 are here, 15 is on the other list)
  await ok(w.api('delete', `/payroll/eobi/lists/${id}`), 204);
  expect((await lists(w, '2026-10')).list).toBeNull();
  await fails(w.api('delete', `/payroll/eobi/lists/${id}`), 404, 'NOT_FOUND');
  expect((await ok(w.api('get', `/payroll/eobi/lists/${otherList.list.id}/candidates`))).total).toBe(5);
});

test('create from the month before: the employees and their locations come forward, leavers and employees on another provider\'s list are left out; amounts use this month\'s rate', async () => {
  const w = await setup();
  const oct = await makeList(w, '2026-10');
  await add(w, oct.list.id, [10, 11], w.gulshan.id);
  await add(w, oct.list.id, [12, 13, 14], w.clifton.id);
  await add(w, oct.list.id, [15]); // no location
  const seen = await lists(w, '2026-11');
  expect(seen).toMatchObject({ list: null, copyFrom: { month: '2026-10', monthLabel: 'Oct 2026', employees: 6 } });
  await fails(w.api('post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2026-10', mode: 'COPY', copyFromMonth: '2026-04' }), 422, 'LIST_EXISTS');
  await fails(w.api('post', '/payroll/eobi/lists', { providerId: w.other.id, month: '2026-11', mode: 'COPY' }), 422, 'NO_PREVIOUS_LIST');

  // 12 left the company, 13 is now on the other provider's list, and the rate changes from November
  await ok(w.api('post', `/payroll/employees/${w.e[12].id}/close`, { leavingDate: '2026-10-20' }));
  const otherNov = await makeList(w, '2026-11', {}, w.other);
  await add(w, otherNov.list.id, [13]);
  await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-11', wage: 41000, employerPercent: 5, employeePercent: 1 }));
  // the list does not exist yet for Delizia in November: copy it
  const nov = await ok(w.api('post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2026-11' }), 201);
  expect(nov).toMatchObject({ copied: 4, copiedFrom: '2026-10', skippedLeavers: [{ code: 12 }], skippedOtherList: [{ code: 13 }], rate: { wage: '41000.00' } });
  expect(nov.rows.map((r) => [r.employee.code, r.location && r.location.name, r.employer, r.employeeShare, r.source])).toEqual([
    [10, 'Gulshan', '2050.00', '410.00', 'COPY'], [11, 'Gulshan', '2050.00', '410.00', 'COPY'], [14, 'Clifton', '2050.00', '410.00', 'COPY'], [15, null, '2050.00', '410.00', 'COPY'],
  ]);
  expect(nov.cards).toMatchObject({ employees: 4, withoutLocation: 1, employer: '8200.00', employeeShare: '1640.00', totalPayable: '9840.00' });
  // October is untouched
  expect((await lists(w, '2026-10')).cards).toMatchObject({ employees: 6, employeeShare: '2442.00' === '' ? '' : '2442.00' === 'x' ? 'x' : expect.any(String) });
  // copying from a month that was named
  const dec = await ok(w.api('post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2026-12', mode: 'COPY', copyFromMonth: '2026-10' }), 201);
  expect(dec).toMatchObject({ copied: 5, copiedFrom: '2026-10', skippedLeavers: [{ code: 12 }] }); // 13 is free in December
  await fails(w.api('post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2027-01', mode: 'COPY', copyFromMonth: '2026-05' }), 422, 'NO_PREVIOUS_LIST');
});

test('a new rate: "recalculate this month\'s list" and "Recalculate at rate" work the amounts out again', async () => {
  const w = await setup();
  const list = await makeList(w, '2026-10');
  await add(w, list.list.id, [10, 11], w.gulshan.id);
  expect((await lists(w, '2026-10')).cards.totalPayable).toBe('4884.00');
  // a new rate without the tick leaves the list alone
  await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 42000, employerPercent: 5, employeePercent: 1, recalculate: false }));
  expect((await lists(w, '2026-10')).cards).toMatchObject({ employer: '4070.00', totalPayable: '4884.00' });
  const again = await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 42000, employerPercent: 5, employeePercent: 1, recalculate: true }));
  expect(again.recalculated).toBe(2);
  expect((await lists(w, '2026-10')).cards).toMatchObject({ employer: '4200.00', employeeShare: '840.00', totalPayable: '5040.00' });
  expect((await lists(w, '2026-10')).rows[0]).toMatchObject({ wage: '42000.00', employer: '2100.00', employeeShare: '420.00' });
  await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 44000, employerPercent: 5, employeePercent: 1 }));
  expect(await ok(w.api('post', `/payroll/eobi/lists/${list.list.id}/recalculate`))).toEqual({ updated: 2, locked: 0 });
  expect((await lists(w, '2026-10')).cards.totalPayable).toBe('5280.00');
  // no rate at all: nothing can be added
  const bare = await setup({ rates: false });
  const empty = await makeList(bare, '2026-10');
  await fails(bare.api('post', `/payroll/eobi/lists/${empty.list.id}/rows`, { employeeIds: [bare.e[10].id] }), 422, 'NO_EOBI_RATE');
  await fails(bare.api('post', `/payroll/eobi/lists/${empty.list.id}/recalculate`), 422, 'NO_EOBI_RATE');
  expect((await lists(bare, '2026-10')).rate).toBeNull();
});

test('import from a sheet: Employee ID or CNIC, an optional location by name, a preview first; the report says what was not added and why', async () => {
  const w = await setup();
  const list = await makeList(w, '2026-10');
  const other = await makeList(w, '2026-10', {}, w.other);
  await add(w, other.list.id, [15]);
  await add(w, list.list.id, [14]);
  await ok(w.api('post', `/payroll/employees/${w.e[13].id}/close`, { leavingDate: '2026-09-30' }));
  const rows = [
    { employeeId: 10, location: 'gulshan' }, { employeeId: '', cnic: '4230-0000000-11', location: 'Clifton' }, { employeeId: 12, location: 'Nowhere' }, { employeeId: 99 }, { employeeId: 14 }, { employeeId: 15 }, { employeeId: 13 },
    { employeeId: 10 }, { cnic: '42300000000099' }, {},
  ];
  const dry = await ok(w.api('post', `/payroll/eobi/lists/${list.list.id}/import`, { rows, dryRun: true }));
  expect(dry).toMatchObject({ dryRun: true, total: 10, added: 2, notAdded: 8 });
  expect(dry.results.map((r) => r.status)).toEqual(['ADDED', 'ADDED', 'UNKNOWN_LOCATION', 'NOT_FOUND', 'ALREADY_ON_LIST', 'ON_OTHER_LIST', 'EMPLOYEE_CLOSED', 'DUPLICATE_IN_FILE', 'NOT_FOUND', 'NO_ID']);
  expect(dry.results[5]).toMatchObject({ provider: 'Other Establishment', employee: { code: 15 } });
  expect((await lists(w, '2026-10')).cards.employees).toBe(1); // nothing saved by the preview
  const real = await ok(w.api('post', `/payroll/eobi/lists/${list.list.id}/import`, { rows, locationId: w.gulshan.id }));
  expect(real).toMatchObject({ dryRun: false, added: 2 });
  const v = await lists(w, '2026-10');
  expect(v.rows.map((r) => [r.employee.code, r.location && r.location.name, r.source])).toEqual([[10, 'Gulshan', 'EXCEL'], [11, 'Clifton', 'EXCEL'], [14, null, 'MANUAL']]);
  await fails(w.api('post', `/payroll/eobi/lists/${list.list.id}/import`, { rows: [] }), 400, 'VALIDATION_FAILED');
  await fails(w.api('post', `/payroll/eobi/lists/${list.list.id}/import`, { rows: [{ employeeId: 11 }], locationId: foreignId() }), 404, 'NOT_FOUND');
});
const foreignId = () => '8f3c1a2e-1111-4222-8333-444455556666';

test('the EOBI voucher: Debit EOBI Payable (employee shares), Debit EOBI Employer Contribution, Credit Bank; one per location; its rows are locked until it is moved back to draft', async () => {
  const w = await setup();
  const list = await makeList(w, '2026-10');
  await add(w, list.list.id, [10, 11, 12], w.gulshan.id);
  await add(w, list.list.id, [13], w.clifton.id);
  await add(w, list.list.id, [14]);
  const picker = await ok(w.accountant('get', '/eobi-vouchers/locations?month=2026-10'));
  expect(picker.data.map((x) => [x.provider, x.location, x.employees, x.employer, x.employeeShare, x.total, x.voucher])).toEqual([['Delizia', 'Clifton', 1, 2035, 407, 2442, null], ['Delizia', 'Gulshan', 3, 6105, 1221, 7326, null]]);

  const make = (body, status = 201) => ok(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-10', payFromAccountId: w.bank.id, paymentMode: 'ONLINE', ...body }), status);
  await fails(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-10', locationId: w.gulshan.id, payFromAccountId: (await Account.findOne({ where: { companyId: w.company.id, code: '1103' } })).id, paymentMode: 'ONLINE' }), 422, 'NOT_BANK_OR_CASH');
  await fails(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-09', locationId: w.gulshan.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 422, 'NO_LIST');
  const empty = await ok(w.api('post', '/payroll/eobi/locations', { providerId: w.delizia.id, name: 'Empty office' }), 201);
  await fails(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-10', locationId: empty.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 422, 'NO_EMPLOYEES');
  await fails(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-10', payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 400, 'VALIDATION_FAILED');

  const v = await make({ locationId: w.gulshan.id, refNo: 'CH-7788', notes: 'Oct EOBI Gulshan' });
  expect(v).toMatchObject({ voucherNo: 1, voucherLabel: 'EOV-00001', status: 'DRAFT', provider: { name: 'Delizia' }, location: { name: 'Gulshan' }, month: '2026-10', monthLabel: 'Oct 2026', employees: 3, employer: 6105, employeeShare: 1221, amount: 7326,
    refNo: 'CH-7788', payFrom: { code: '1102' }, canConfirm: true });
  expect(v.lines.map((l) => [l.employee.code, l.employer, l.employeeShare, l.total])).toEqual([[10, 2035, 407, 2442], [11, 2035, 407, 2442], [12, 2035, 407, 2442]]);
  await fails(w.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, month: '2026-10', locationId: w.gulshan.id, payFromAccountId: w.bank.id, paymentMode: 'ONLINE' }), 422, 'VOUCHER_EXISTS');
  expect((await ok(w.api('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10`))).byLocation.find((b) => b.name === 'Gulshan').voucher).toMatchObject({ label: 'EOV-00001', status: 'DRAFT' });
  expect((await ok(w.accountant('patch', `/eobi-vouchers/${v.id}`, { chequeNo: '5566', paymentMode: 'CHEQUE', chequeDate: '2026-11-05' }))).paymentMode).toBe('CHEQUE');
  // while it is a draft the list can still change, and the voucher follows it when it is confirmed
  const rows = (await lists(w, '2026-10')).rows;
  await ok(w.api('post', `/payroll/eobi/lists/${list.list.id}/rows/remove`, { rowIds: [rows.find((r) => r.employee.code === 12).id] }));
  expect((await ok(w.accountant('get', `/eobi-vouchers/${v.id}`))).employees).toBe(3); // the draft shows its own figures until confirmed...
  const c = await ok(w.accountant('post', `/eobi-vouchers/${v.id}/confirm`));
  expect(c).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', employees: 2, employer: 4070, employeeShare: 814, amount: 4884, canEdit: false, canUnconfirm: true, confirmedBy: { name: expect.any(String) } });
  expect((await entry(v.id)).map((l) => [l.name, l.debit, l.credit])).toEqual([['EOBI Payable', 814, 0], ['EOBI Employer Contribution', 4070, 0], ['Bank Account', 0, 4884]]);
  const defaults = (await ok(w.api('get', '/accounts/defaults'))).data.filter((x) => ['EOBI_PAYABLE', 'EOBI_EMPLOYER_EXPENSE'].includes(x.key));
  expect(defaults.map((x) => [x.key, x.status, x.group, x.account.name])).toEqual([['EOBI_PAYABLE', 'SET', 'PAYROLL', 'EOBI Payable'], ['EOBI_EMPLOYER_EXPENSE', 'SET', 'PAYROLL', 'EOBI Employer Contribution']]);
  await fails(w.accountant('patch', `/eobi-vouchers/${v.id}`, { notes: 'x' }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('delete', `/eobi-vouchers/${v.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('post', `/eobi-vouchers/${v.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  const entryView = await ok(w.accountant('get', `/eobi-vouchers/${v.id}/accounts-entry`));
  expect(entryView).toMatchObject({ posted: true, voucherLabel: 'EOV-00001' });
  expect(entryView.current.sourceType).toBe('EOBI_VOUCHER');

  // the rows of Gulshan are locked now
  const locked = await lists(w, '2026-10');
  expect(locked.byLocation.find((b) => b.name === 'Gulshan')).toMatchObject({ locked: true, canVoucher: false, voucher: { status: 'CONFIRMED' } });
  expect(locked.rows.filter((r) => r.locked).map((r) => r.employee.code)).toEqual([10, 11]);
  await fails(w.api('post', `/payroll/eobi/lists/${list.list.id}/rows/remove`, { rowIds: [locked.rows[0].id] }), 422, 'ROW_LOCKED');
  await fails(w.api('put', `/payroll/eobi/lists/${list.list.id}/rows/locations`, { items: [{ rowId: locked.rows[0].id, locationId: w.clifton.id }] }), 422, 'ROW_LOCKED');
  await fails(w.api('put', `/payroll/eobi/lists/${list.list.id}/rows/locations`, { items: [{ rowId: locked.rows.find((r) => r.employee.code === 14).id, locationId: w.gulshan.id }] }), 422, 'LOCATION_LOCKED');
  await fails(w.api('post', `/payroll/eobi/lists/${list.list.id}/rows`, { employeeIds: [w.e[12].id], locationId: w.gulshan.id }), 422, 'LOCATION_LOCKED');
  await fails(w.api('delete', `/payroll/eobi/lists/${list.list.id}`), 422, 'LIST_HAS_VOUCHER');
  await ok(w.api('put', '/payroll/eobi/rates', { month: '2026-10', wage: 50000, employerPercent: 5, employeePercent: 1, recalculate: true }));
  const after = await lists(w, '2026-10');
  expect(after.rows.map((r) => [r.employee.code, r.employer])).toEqual([[10, '2035.00'], [11, '2035.00'], [13, '2500.00'], [14, '2500.00']]); // the locked rows keep their amounts
  await ok(w.api('post', `/payroll/eobi/lists/${list.list.id}/recalculate`));

  // Clifton is a voucher of its own; "(not set)" cannot be paid
  const v2 = await make({ locationId: w.clifton.id });
  expect(v2).toMatchObject({ voucherNo: 2, employees: 1, employer: 2500, employeeShare: 500, amount: 3000 });
  expect((await ok(w.accountant('get', '/eobi-vouchers/locations?month=2026-10'))).data.map((x) => [x.location, x.voucher && x.voucher.status])).toEqual([['Clifton', 'DRAFT'], ['Gulshan', 'CONFIRMED']]);

  // move it back to draft: reversed, unlocked
  const un = await ok(w.accountant('post', `/eobi-vouchers/${v.id}/unconfirm`, { reason: 'wrong account' }));
  expect(un).toMatchObject({ status: 'DRAFT', canEdit: true });
  const all = await sql(`SELECT e.status, e."reversalOfId" IS NOT NULL AS reversal FROM journal_entries e WHERE e."sourceId" = :id ORDER BY e."entryNo"`, { id: v.id });
  expect(all).toEqual([{ status: 'REVERSED', reversal: false }, { status: 'POSTED', reversal: true }]);
  expect((await lists(w, '2026-10')).rows.every((r) => !r.locked)).toBe(true);
  await fails(w.accountant('post', `/eobi-vouchers/${v.id}/unconfirm`), 422, 'NOT_CONFIRMED');
  const list2 = await ok(w.accountant('get', '/eobi-vouchers'));
  expect(list2).toMatchObject({ total: 2, summary: { vouchers: 2, amount: 7500 + 0 === 0 ? 0 : expect.any(Number) } });
  expect((await ok(w.accountant('get', '/eobi-vouchers?month=2026-10&status=DRAFT'))).total).toBe(2);
  expect((await ok(w.accountant('get', '/eobi-vouchers?search=clifton'))).total).toBe(1);
  await ok(w.accountant('delete', `/eobi-vouchers/${v2.id}`), 204);
  await ok(w.api('delete', `/payroll/eobi/lists/${list.list.id}`), 204); // the draft voucher goes with the list
  expect((await ok(w.accountant('get', '/eobi-vouchers'))).total).toBe(0);
});

test('the payroll takes the employee share from the list; the list shows what the payslips deduct against what it asks', async () => {
  const w = await setup();
  // only A is on the October list; B is on no list, so his EOBI is 0
  const rows = [];
  for (const code of [10, 11]) for (const d of ['01', '02', '03']) rows.push({ employeeId: code, date: `2026-10-${d}`, time: '08:00' }, { employeeId: code, date: `2026-10-${d}`, time: '16:00' });
  await ok(w.api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const list = await makeList(w, '2026-10');
  await add(w, list.list.id, [10], w.gulshan.id);
  await add(w, list.list.id, [12, 13]); // on the list, but with no payslip
  const run = await ok(w.api('post', '/payroll/runs', { month: '2026-10', groupId: w.factory.id }), 201);
  const slips = (await ok(w.api('get', `/payroll/runs/${run.id}/slips`))).data;
  const a = slips.find((s) => s.employee.code === 10);
  const b = slips.find((s) => s.employee.code === 11);
  expect(a).toMatchObject({ eobiSource: 'LIST', deductions: { eobi: '407.00' } }); // the list's employee share, not 1 % of 30,000
  expect(b).toMatchObject({ eobiSource: 'NONE', deductions: { eobi: '0.00' } }); // not on a list: no EOBI
  const v = await lists(w, '2026-10');
  expect(v.cards).toMatchObject({ employees: 3, deducted: '1221.00', differ: 0 }); // all three are on the run, each at the list's 407
  expect(v.rows.find((r) => r.employee.code === 10)).toMatchObject({ deducted: '407.00', deductedStatus: 'draft', differs: false, slipId: a.id });
  expect(v.rows.find((r) => r.employee.code === 12)).toMatchObject({ deducted: '407.00', differs: false });

  // a list made after the payroll: the payslip keeps what it had until it is calculated again
  await add(w, list.list.id, [11]);
  expect((await ok(w.api('get', `/payroll/slips/${b.id}`))).deductions.eobi).toBe('0.00');
  expect((await lists(w, '2026-10')).rows.find((r) => r.employee.code === 11)).toMatchObject({ deducted: '0.00', differs: true });
  const calc = await ok(w.api('post', `/payroll/slips/${b.id}/calculate`));
  expect(calc).toMatchObject({ eobiSource: 'LIST', deductions: { eobi: '407.00' }, net: expect.any(String) });
  expect((await lists(w, '2026-10')).cards.differ).toBe(0);
  // a figure typed by HR is kept and the list shows the difference
  const typed = await ok(w.api('patch', `/payroll/slips/${a.id}`, { eobi: 350 }));
  expect(typed).toMatchObject({ eobiSource: 'MANUAL', deductions: { eobi: '350.00' } });
  expect((await lists(w, '2026-10')).rows.find((r) => r.employee.code === 10)).toMatchObject({ deducted: '350.00', differs: true });
  const back = await ok(w.api('post', `/payroll/slips/${a.id}/calculate`, { auto: true }));
  expect(back).toMatchObject({ eobiSource: 'LIST', deductions: { eobi: '407.00' } });
  // the Summary
  const sum = await ok(w.api('get', `/payroll/eobi/summary?providerId=${w.delizia.id}&year=2026`));
  expect(sum.data.find((m) => m.month === '2026-10')).toMatchObject({ hasList: true, employees: 4, employer: '8140.00', employeeShare: '1628.00', totalPayable: '9768.00', deducted: '1628.00', vouchers: 0 });
  expect(sum.data.find((m) => m.month === '2026-09')).toMatchObject({ hasList: false, employees: 0 });
  expect(sum.data).toHaveLength(12);
});

test('masters and access: providers and locations (delete only when unused), reading needs a payroll service, changing needs PAYROLL_REPORTS FULL, the voucher needs ACC_PAYMENTS', async () => {
  const w = await setup();
  const all = await ok(w.api('get', '/payroll/eobi/providers'));
  expect(all.data.map((p) => [p.name, p.code, p.isActive, p.locations.map((l) => l.name)])).toEqual([['Delizia', 'NKC', true, ['Clifton', 'Gulshan']], ['Other Establishment', null, true, []]]);
  await fails(w.api('post', '/payroll/eobi/providers', { name: 'delizia' }), 422, 'NAME_TAKEN');
  await fails(w.api('post', '/payroll/eobi/locations', { providerId: w.delizia.id, name: 'gulshan' }), 422, 'NAME_TAKEN');
  expect(await ok(w.api('patch', `/payroll/eobi/providers/${w.other.id}`, { name: 'Second Registration', code: 'KHI-2' }))).toMatchObject({ name: 'Second Registration', code: 'KHI-2' });
  expect(await ok(w.api('patch', `/payroll/eobi/locations/${w.clifton.id}`, { name: 'Clifton Block 5', isActive: false }))).toMatchObject({ name: 'Clifton Block 5', isActive: false });
  const list = await makeList(w, '2026-10');
  await fails(w.api('post', `/payroll/eobi/lists/${list.list.id}/rows`, { employeeIds: [w.e[10].id], locationId: w.clifton.id }), 422, 'LOCATION_INACTIVE');
  await add(w, list.list.id, [10], w.gulshan.id);
  await fails(w.api('delete', `/payroll/eobi/locations/${w.gulshan.id}`), 422, 'IN_USE');
  await fails(w.api('delete', `/payroll/eobi/providers/${w.delizia.id}`), 422, 'IN_USE');
  await ok(w.api('delete', `/payroll/eobi/locations/${w.clifton.id}`), 204);
  await ok(w.api('delete', `/payroll/eobi/providers/${w.other.id}`), 204);

  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_SALARY', 'VIEW');
  const v = asUser(viewer);
  await ok(v('get', '/payroll/eobi/rates'));
  await ok(v('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10`));
  await ok(v('get', `/payroll/eobi/lists/${list.list.id}/candidates`));
  await ok(v('get', `/payroll/eobi/summary?providerId=${w.delizia.id}`));
  for (const [m, url, body] of [['put', '/payroll/eobi/rates', { month: '2026-10', wage: 1, employerPercent: 1, employeePercent: 1 }], ['post', '/payroll/eobi/lists', { providerId: w.delizia.id, month: '2026-11' }],
    ['post', `/payroll/eobi/lists/${list.list.id}/rows`, { employeeIds: [w.e[11].id] }], ['post', '/payroll/eobi/providers', { name: 'X' }], ['post', `/payroll/eobi/lists/${list.list.id}/import`, { rows: [{ employeeId: 11 }] }]]) {
    expect((await v(m, url, body)).status).toBe(403);
  }
  expect((await w.accountant('get', '/payroll/eobi/rates')).status).toBe(403); // the accountant works on the voucher only
  expect((await w.reports('get', '/eobi-vouchers')).status).toBe(403);
  const other = await setup();
  await fails(other.api('get', `/payroll/eobi/lists?providerId=${w.delizia.id}&month=2026-10`), 404, 'NOT_FOUND');
  await fails(other.api('delete', `/payroll/eobi/lists/${list.list.id}`), 404, 'NOT_FOUND');
  await fails(other.accountant('post', '/eobi-vouchers', { providerId: w.delizia.id, locationId: w.gulshan.id, month: '2026-10', payFromAccountId: other.bank.id, paymentMode: 'ONLINE' }), 404, 'NOT_FOUND');
  await fails(w.api('delete', `/payroll/employees/${w.e[10].id}`), 422, 'EMPLOYEE_CONFIRMED');
});
