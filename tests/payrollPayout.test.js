const { app, request, clean, makeUser, makeCompany, loginAs } = require('./helpers');
const { Service, CompanyService, UserService, sequelize } = require('../src/models');

jest.setTimeout(400000);
beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS'];
const tokenOf = async (u) => `Bearer ${(await loginAs(u)).accessToken}`;
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: await tokenOf(u) }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, code]); return r.body.error; };
const grant = async (user, code, access) => UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
const binary = (res) => { res.buffer(true); res.parse((r, done) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => done(null, Buffer.concat(c))); }); return res; };
const cents = (s) => Math.round(Number(s) * 100);

test('bank upload file: preview, make (kept and ticked), make again, download again, send back clears the tick', async () => {
  const w = await setup();
  const base = `/payroll/runs/${w.run.id}`;
  // nothing is approved yet
  let pre = await ok(w.api('get', `${base}/bank-file`));
  expect(pre).toMatchObject({ count: 0, total: '0.00', notApproved: 2, format: { key: 'MEEZAN', name: 'Meezan Bank' }, scope: 'unpaid' });
  await fails(w.hr('post', `${base}/bank-file`, {}), 422, 'NO_ROWS');

  await approveAll(w);
  const slips = (await ok(w.api('get', `${base}/slips`))).data;
  const of = (code) => slips.find((s) => s.employee.code === code);
  pre = await ok(w.api('get', `${base}/bank-file`));
  expect(pre.count).toBe(2);
  expect(pre.notApproved).toBe(0);
  expect(cents(pre.total)).toBe(cents(of(10).net) + cents(of(11).net));
  expect(pre.data[0]).toMatchObject({ sr: 1, employee: { code: 10 }, accountNo: '0123456789012', accountTitle: 'Zaid Khan', bankName: 'Meezan Bank', amount: of(10).net, details: 'Salary October 2026', reference: 'SAL-202610-00010', alreadyInFile: null });
  expect(pre.data[1]).toMatchObject({ employee: { code: 11 }, accountNo: 'PK36HABB0000001234567702', bankName: 'HBL' });
  // previewing ticks nothing
  expect((await ok(w.api('get', `${base}/slips`))).data.every((s) => s.bankFile === null)).toBe(true);
  expect((await ok(w.api('get', base))).bankFile).toMatchObject({ bankSlips: 2, inFile: 0, last: null });

  // make the file
  const made = await ok(w.hr('post', `${base}/bank-file`, { format: 'MEEZAN' }), 201);
  expect(made).toMatchObject({ code: 1, label: 'BF-00001', format: 'MEEZAN', formatName: 'Meezan Bank', scope: 'unpaid', employees: 2, skipped: [] });
  expect(made.fileName).toMatch(/^Meezan-Bank-salary-.*-2026-10-BF00001\.csv$/);
  expect(cents(made.total)).toBe(cents(pre.total));
  const dl = await request(app).get(`/api/v1/payroll/bank-files/${made.id}/download`).set({ Authorization: await tokenOf(w.admin) });
  expect(dl.status).toBe(200);
  expect(dl.headers['content-type']).toMatch(/text\/csv/);
  expect(dl.headers['content-disposition']).toContain('BF00001.csv');
  const first = dl.text;
  const lines = first.split('\r\n');
  expect(lines[0]).toBe('Sr No,Beneficiary Account No / IBAN,Beneficiary Title,Beneficiary Bank,Transfer Type,Amount,Payment Details,Reference No');
  expect(lines[1]).toBe(`1,0123456789012,Zaid Khan,Meezan Bank,Within Meezan,${of(10).net},Salary October 2026,SAL-202610-00010`);
  expect(lines[2]).toBe(`2,PK36HABB0000001234567702,Dan Ali,HBL,Other Bank (IBFT),${of(11).net},Salary October 2026,SAL-202610-00011`);
  expect(lines).toHaveLength(4); // header + 2 rows + the empty piece after the last line break: no total line

  // the tick: on the payslips and on the payroll
  const after = (await ok(w.api('get', `${base}/slips`))).data;
  expect(after.filter((s) => s.bankFile).map((s) => [s.employee.code, s.bankFile.label])).toEqual([[10, 'BF-00001'], [11, 'BF-00001']]);
  expect(after.find((s) => s.employee.code === 12).bankFile).toBeNull(); // cash
  const run = await ok(w.api('get', base));
  expect(run.bankFile).toMatchObject({ bankSlips: 2, inFile: 2, last: { code: 1, label: 'BF-00001', employees: 2 } });
  // the preview now says which payslips are already in a file
  expect((await ok(w.api('get', `${base}/bank-file`))).data.map((d) => d.alreadyInFile.label)).toEqual(['BF-00001', 'BF-00001']);

  // it can be made again; the first file is kept exactly as it was
  const again = await ok(w.hr('post', `${base}/bank-file`, {}), 201);
  expect(again.label).toBe('BF-00002');
  const list = await ok(w.api('get', `${base}/bank-files`));
  expect(list.data.map((f) => f.label)).toEqual(['BF-00002', 'BF-00001']);
  expect(list.data[0]).toMatchObject({ employees: 2, format: 'MEEZAN', createdBy: expect.any(String) });
  const dl1 = await request(app).get(`/api/v1/payroll/bank-files/${made.id}/download`).set({ Authorization: await tokenOf(w.admin) });
  expect(dl1.text).toBe(first);
  // only the payslips that are not in a file yet: none left
  await fails(w.hr('post', `${base}/bank-file`, { onlyNew: true }), 422, 'NO_ROWS');

  // a payslip paid in full is not waiting any more: out of the default file, in the "all" file
  await sequelize.query('UPDATE payroll_slips SET "paidAmount" = "netAmount" WHERE id = :id', { replacements: { id: of(11).id } });
  const unpaid = await ok(w.api('get', `${base}/bank-file`));
  expect(unpaid.data.map((d) => d.employee.code)).toEqual([10]);
  expect(unpaid.settled).toBe(1);
  const all = await ok(w.api('get', `${base}/bank-file?scope=all`));
  expect(all.data.map((d) => d.employee.code)).toEqual([10, 11]);
  // part paid: the file asks for the rest
  await sequelize.query('UPDATE payroll_slips SET "paidAmount" = 1000, "netAmount" = "netAmount" WHERE id = :id', { replacements: { id: of(10).id } });
  expect((await ok(w.api('get', `${base}/bank-file`))).data[0].amount).toBe((cents(of(10).net) / 100 - 1000).toFixed(2));
  await sequelize.query('UPDATE payroll_slips SET "paidAmount" = 0 WHERE id IN (:ids)', { replacements: { ids: [of(10).id, of(11).id] } });

  // a payslip with no account number cannot go in: it is listed, not forgotten
  await sequelize.query(`UPDATE payroll_slips SET "accountNo" = '' WHERE id = :id`, { replacements: { id: of(11).id } });
  const noAcc = await ok(w.api('get', `${base}/bank-file`));
  expect(noAcc.data.map((d) => d.employee.code)).toEqual([10]);
  expect(noAcc.skipped).toEqual([expect.objectContaining({ reason: 'NO_ACCOUNT', employee: expect.objectContaining({ code: 11 }) })]);

  // send an approved payslip back to Draft: it is no longer the one in the file, the tick goes
  await ok(w.api('post', `/payroll/slips/${of(10).id}/send-back`));
  const back = (await ok(w.api('get', `${base}/slips`))).data;
  expect(back.find((s) => s.employee.code === 10).bankFile).toBeNull();
  expect(back.find((s) => s.employee.code === 11).bankFile).toMatchObject({ label: 'BF-00002' });
  expect((await ok(w.api('get', base))).bankFile).toMatchObject({ bankSlips: 1, inFile: 1 });
  expect((await ok(w.api('get', `${base}/bank-file`))).notApproved).toBe(1);

  // access: viewing is for payroll people; making a file needs Salary FULL; another company sees nothing
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  expect((await asUser(viewer)('get', `${base}/bank-file`)).status).toBe(200);
  expect((await asUser(viewer)('post', `${base}/bank-file`, {})).status).toBe(403);
  const nobody = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(nobody, 'ACC_PAYMENTS', 'FULL');
  expect((await asUser(nobody)('get', `${base}/bank-file`)).status).toBe(403);
  const other = await setup();
  expect((await other.api('get', `${base}/bank-file`)).status).toBe(404);
  expect((await other.hr('post', `${base}/bank-file`, {})).status).toBe(404);
  expect((await other.api('get', `/payroll/bank-files/${made.id}/download`)).status).toBe(404);
  expect((await w.api('get', `${base}/bank-file?format=HBL`)).status).toBe(400);
});

test('cash sheet: the notes of each envelope, the notes to bring, Excel and PDF', async () => {
  const w = await setup();
  const base = `/payroll/runs/${w.run.id}`;
  expect((await ok(w.api('get', `${base}/cash-sheet`))).data).toEqual([]);
  await approveAll(w);
  const slips = (await ok(w.api('get', `${base}/slips`))).data;
  const net = (code) => slips.find((s) => s.employee.code === code).net;
  expect(net(12)).toBe('50650.00');
  expect(net(13)).toBe('35651.00');

  const sheet = await ok(w.api('get', `${base}/cash-sheet`));
  expect(sheet).toMatchObject({ scope: 'unpaid', denominations: [5000, 1000, 500, 100, 50, 20, 10], notApproved: 0 });
  expect(sheet.run).toMatchObject({ month: '2026-10', monthLabel: 'October 2026' });
  expect(sheet.data.map((r) => [r.sr, r.employee.code, r.amount])).toEqual([[1, 12, '50650.00'], [2, 13, '35651.00']]);
  // 50,650 = 10 x 5000 + 1 x 500 + 1 x 100 + 1 x 50
  expect(sheet.data[0]).toMatchObject({ notes: { 5000: 10, 1000: 0, 500: 1, 100: 1, 50: 1, 20: 0, 10: 0 }, rest: '0.00' });
  // 35,651 = 7 x 5000 + 1 x 500 + 1 x 100 + 1 x 50 + 1 left
  expect(sheet.data[1]).toMatchObject({ notes: { 5000: 7, 1000: 0, 500: 1, 100: 1, 50: 1, 20: 0, 10: 0 }, rest: '1.00' });
  expect(sheet.totals).toMatchObject({ employees: 2, amount: '86301.00', rest: '1.00', notes: { 5000: 17, 500: 2, 100: 2, 50: 2 } });
  // the notes to bring add up to the total cash
  const brought = sheet.totals.noteValues.reduce((t, n) => t + cents(n.value), 0) + cents(sheet.totals.rest);
  expect(brought).toBe(cents(sheet.totals.amount));
  expect(sheet.totals.noteValues[0]).toEqual({ denomination: 5000, count: 17, value: '85000.00' });

  // the notes can be chosen (no 5000 and 20 here): the rest is what is under the smallest note
  const custom = await ok(w.api('get', `${base}/cash-sheet?denominations=1000,500,100`));
  expect(custom.denominations).toEqual([1000, 500, 100]);
  expect(custom.data[0].notes).toEqual({ 1000: 50, 500: 1, 100: 1 });
  expect(custom.data[0].rest).toBe('50.00');
  expect(custom.data[1].rest).toBe('51.00');
  expect((await w.api('get', `${base}/cash-sheet?denominations=abc`)).status).toBe(400);

  // a part payment: the sheet asks for the rest of the net; scope=all for the whole net
  await sequelize.query('UPDATE payroll_slips SET "paidAmount" = 650 WHERE id = :id', { replacements: { id: slips.find((s) => s.employee.code === 12).id } });
  expect((await ok(w.api('get', `${base}/cash-sheet`))).data[0].amount).toBe('50000.00');
  expect((await ok(w.api('get', `${base}/cash-sheet?scope=all`))).data[0].amount).toBe('50650.00');
  await sequelize.query('UPDATE payroll_slips SET "paidAmount" = "netAmount" WHERE id = :id', { replacements: { id: slips.find((s) => s.employee.code === 12).id } });
  expect((await ok(w.api('get', `${base}/cash-sheet`))).data.map((r) => r.employee.code)).toEqual([13]);

  const xl = await binary(request(app).get(`/api/v1${base}/cash-sheet?format=xlsx`).set({ Authorization: await tokenOf(w.admin) }));
  expect(xl.status).toBe(200);
  expect(xl.headers['content-type']).toMatch(/spreadsheetml/);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xl.body);
  const ws = wb.getWorksheet('Cash Sheet');
  expect(ws.getCell(4, 3).value).toBe('Name');
  expect(ws.getCell(4, 6).value).toBe('5000');
  expect(ws.getCell(5, 3).value).toBe('HIRA SHAH');
  expect(ws.getCell(5, 5).value).toBe(35651);
  expect(ws.getRow(6).getCell(3).value).toBe('Total (1 employees)');
  const pdf = await binary(request(app).get(`/api/v1${base}/cash-sheet?format=pdf`).set({ Authorization: await tokenOf(w.admin) }));
  expect(pdf.status).toBe(200);
  expect(pdf.headers['content-type']).toBe('application/pdf');
  expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  expect((await w.api('get', `${base}/cash-sheet?format=csv`)).status).toBe(400);

  const other = await setup();
  expect((await other.api('get', `${base}/cash-sheet`)).status).toBe(404);
  const nobody = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(nobody, 'ACC_PAYMENTS', 'FULL');
  expect((await asUser(nobody)('get', `${base}/cash-sheet`)).status).toBe(403);
});

async function approveAll(w) {
  const slips = (await ok(w.api('get', `/payroll/runs/${w.run.id}/slips`))).data;
  for (const s of slips) {
    await ok(w.hr('post', `/payroll/slips/${s.id}/review`));
    await ok(w.api('post', `/payroll/slips/${s.id}/final-review`));
    await ok(w.api('post', `/payroll/slips/${s.id}/approve`));
  }
}

/** October 2026. Bank: Zaid (10, Meezan), Dan (11, HBL). Cash: Fatima (12, FIXED 45,000), Hira (13, FIXED 30,001); all with food 3,100, maintenance 1,550 and mobile 1,000. */
async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: factory.id, name: 'Assembly', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Worker' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '08:00', endTime: '16:00', dutyHours: 8 }), 201);
  const meezan = await ok(api('post', '/payroll/banks', { name: 'Meezan Bank', shortName: 'MEZN', bankCode: '0110' }), 201);
  const hbl = await ok(api('post', '/payroll/banks', { name: 'HBL', shortName: 'HBL', bankCode: '0010' }), 201);
  const emp = async (code, name, extra) => {
    const e = await ok(api('post', '/payroll/employees', { code, name, cnic: `4230${String(code).padStart(9, '0')}`, groupId: factory.id, departmentId: dept.id, designationId: worker.id, shiftId: shift.id,
      joiningDate: '2025-01-01', foodAllowance: 3100, maintenanceAllowance: 1550, mobileAllowance: 1000, ...extra }), 201);
    await ok(api('post', `/payroll/employees/${e.id}/confirm`));
    return e;
  };
  await emp(10, 'Zaid Khan', { basicSalary: 31000, paymentMethod: 'BANK', bankId: meezan.id, accountNo: '0123-4567 8901 2', accountTitle: 'Zaid Khan' });
  await emp(11, 'Dan Ali', { basicSalary: 31000, paymentMethod: 'BANK', bankId: hbl.id, accountNo: 'pk36habb0000001234567702', accountTitle: 'Dan Ali' });
  await emp(12, 'Fatima Noor', { basicSalary: 45000, salaryType: 'FIXED' });
  await emp(13, 'Hira Shah', { basicSalary: 30001, salaryType: 'FIXED' });
  const days = ['01', '02', '03', '05', '06', '07', '08', '09', '12', '13', '14', '15', '16', '19', '20'];
  const rows = [10, 11].flatMap((code) => days.flatMap((d) => [{ employeeId: code, date: `2026-10-${d}`, time: '08:00' }, { employeeId: code, date: `2026-10-${d}`, time: '16:00' }]));
  await ok(api('post', '/payroll/attendance/punches/import', { rows }), 201);
  const run = await ok(api('post', '/payroll/runs', { month: '2026-10', groupId: factory.id }), 201);
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrUser, 'PAYROLL_SALARY', 'FULL');
  return { company, admin, api, hr: asUser(hrUser), run };
}
