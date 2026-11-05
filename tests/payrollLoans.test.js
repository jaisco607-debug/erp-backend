const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService, UserService, Account } = require('../src/models');

beforeEach(clean);

const SERVICES = ['PAYROLL_SALARY', 'PAYROLL_REPORTS', 'PAYROLL_APPLICATIONS', 'PAYROLL_EMPLOYEES', 'ACC_COA', 'ACC_PAYMENTS', 'ACC_REPORTS'];
const asUser = (u) => async (m, url, body) => request(app)[m](`/api/v1${url}`).set({ Authorization: `Bearer ${(await loginAs(u)).accessToken}` }).send(body);
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.body && r.body.error && r.body.error.code]).toEqual([status, undefined]); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect(r.status).toBe(status); if (code) expect(r.body.error.code).toBe(code); return r.body.error; };
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'), Buffer.alloc(40, 1), Buffer.from('ffd9', 'hex')]);

async function grant(user, code, access) {
  await UserService.create({ userId: user.id, serviceId: (await Service.findOne({ where: { code } })).id, access });
}
async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const api = asUser(admin);
  await ok(api('post', '/accounts/apply-template', { templateKey: 'other' }));
  const [factory, , , adminGroup] = (await ok(api('get', '/payroll/groups'))).data;
  const dept = await ok(api('post', '/payroll/departments', { groupId: adminGroup.id, name: 'Administration', fte: 0 }), 201);
  const worker = await ok(api('post', '/payroll/designations', { name: 'Clerk' }), 201);
  const shift = await ok(api('post', '/payroll/shifts', { code: 'DAY8', startTime: '09:00', endTime: '17:00', dutyHours: 8 }), 201);
  const emp = (code, name, salary) => ok(api('post', '/payroll/employees', { code, name, fatherName: 'Shahid Ullah', cnic: `4230${String(code).padStart(9, '0')}`, groupId: adminGroup.id, departmentId: dept.id,
    designationId: worker.id, shiftId: shift.id, joiningDate: '2025-08-12', basicSalary: salary }), 201);
  const faizan = await emp(514, 'Muhammad Faizan', 42000);
  const zamin = await emp(420, 'Zamin Ali', 30000);
  const hrUser = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(hrUser, 'PAYROLL_APPLICATIONS', 'FULL');
  const accountant = await makeUser({ userType: 'USER', companyId: company.id });
  await grant(accountant, 'ACC_PAYMENTS', 'FULL');
  const bank = await Account.findOne({ where: { companyId: company.id, code: '1102' } });
  const receivable = await Account.findOne({ where: { companyId: company.id, code: '1103' } });
  return { company, admin, api, hr: asUser(hrUser), hrUser, accountant: asUser(accountant), factory, adminGroup, dept, faizan, zamin, bank, receivable,
    hrToken: (await loginAs(hrUser)).accessToken };
}
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const NEXT = (() => { const [y, m] = TODAY.split('-').map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`; })();
const loan = (w, extra = {}) => ({ employeeId: w.faizan.id, appliedAmount: 30000, months: 3, deductFrom: NEXT, remarks: 'Family need', ...extra });
const payload = (w, loanId, extra = {}) => ({ loanId, payFromAccountId: w.bank.id, paymentMode: 'ONLINE', amount: 10000, refNo: '11934', ...extra });
async function approved(w, extra = {}, review = null) {
  const a = await ok(w.hr('post', '/payroll/loans', loan(w, extra)), 201);
  await ok(w.hr('post', `/payroll/loans/${a.id}/submit`));
  if (review) await ok(w.api('patch', `/payroll/loans/${a.id}/review`, review));
  return ok(w.api('post', `/payroll/loans/${a.id}/approve`));
}

test('create: the loan cannot be more than the salary; the instalments, the first month and the amounts are checked; one open application per employee', async () => {
  const w = await setup();
  const e = await fails(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 42001 })), 422, 'LOAN_MORE_THAN_SALARY');
  expect(e.details).toEqual({ salary: '42000.00', amount: '42001.00' });
  await fails(w.hr('post', '/payroll/loans', loan(w, { months: 13 })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/loans', loan(w, { months: 0 })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: -5 })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/loans', loan(w, { deductFrom: '2026-13' })), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', '/payroll/loans', loan(w, { applicationDate: TODAY, deductFrom: '2020-01' })), 422, 'DEDUCT_FROM_BEFORE_APPLICATION');
  await fails(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 11, months: 12 })), 422, 'LOAN_TOO_SMALL_FOR_PERIOD');
  await fails(w.hr('post', '/payroll/loans', loan(w, { applicationDate: '2999-01-01' })), 422, 'DATE_IN_FUTURE');
  await fails(w.hr('post', '/payroll/loans', loan(w, { employeeId: '8f3c1a2e-1111-4222-8333-444455556666' })), 404, 'NOT_FOUND');
  await fails(w.hr('post', '/payroll/loans', { employeeId: w.faizan.id }), 400, 'VALIDATION_FAILED');
  // as much as the whole salary is allowed
  const a = await ok(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: '42000.00', months: 1 })), 201);
  expect(a).toMatchObject({ code: 1, appId: '00001', label: 'Application # 1', status: 'DRAFT', applied: '42000.00', approved: null, months: 1, emi: '42000.00',
    paid: '0.00', deducted: '0.00', balance: '0.00', canEdit: true, canSubmit: true, canApprove: false, canPay: false });
  await fails(w.hr('post', '/payroll/loans', loan(w)), 422, 'LOAN_APPLICATION_OPEN');
  await ok(w.hr('delete', `/payroll/loans/${a.id}`), 204);
  await fails(w.hr('delete', `/payroll/loans/${a.id}`), 404, 'NOT_FOUND');
});

test('the application as the screen shows it: the employee, the instalment schedule, previous loans; edit, send, withdraw', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 40000, months: 3, deductFrom: '2026-11', applicationDate: '2026-10-29' })), 201);
  expect(a).toMatchObject({ applicationDate: '2026-10-29', applied: '40000.00', months: 3, deductFrom: '2026-11', deductFromCode: '112026', emi: '13333.00', remarks: 'Family need',
    employee: { code: 514, label: '00514', name: 'MUHAMMAD FAIZAN', fatherName: 'SHAHID ULLAH', salary: '42000.00', currentLoan: '0.00', currentAdvance: '0.00', group: { name: 'Admin' }, department: { name: 'Administration' }, designation: 'Clerk' },
    schedule: { total: '40000.00', rows: [{ month: '2026-11', label: 'NOV-2026', emi: '13333.00' }, { month: '2026-12', label: 'DEC-2026', emi: '13333.00' }, { month: '2027-01', label: 'JAN-2027', emi: '13334.00' }] },
    previousLoans: [], payments: [], deductions: [], attachments: [] });
  expect(a.employee.service).toMatch(/^\dy \dm$/);
  const p = await ok(w.hr('patch', `/payroll/loans/${a.id}`, { appliedAmount: 39000, months: 2, remarks: '' }));
  expect(p).toMatchObject({ applied: '39000.00', months: 2, emi: '19500.00', remarks: null });
  await fails(w.hr('patch', `/payroll/loans/${a.id}`, { appliedAmount: 43000 }), 422, 'LOAN_MORE_THAN_SALARY');
  expect(await ok(w.hr('post', `/payroll/loans/${a.id}/submit`))).toMatchObject({ status: 'IN_REVIEW', statusText: 'In review', canEdit: false, canWithdraw: true, submittedBy: expect.any(String) });
  await fails(w.hr('patch', `/payroll/loans/${a.id}`, { months: 4 }), 422, 'LOAN_IN_REVIEW');
  await fails(w.hr('delete', `/payroll/loans/${a.id}`), 422, 'LOAN_IN_REVIEW');
  await fails(w.hr('post', `/payroll/loans/${a.id}/submit`), 422, 'ALREADY_IN_REVIEW');
  expect(await ok(w.hr('post', `/payroll/loans/${a.id}/withdraw`))).toMatchObject({ status: 'DRAFT', canEdit: true });
  await fails(w.hr('post', `/payroll/loans/${a.id}/withdraw`), 422, 'NOT_IN_REVIEW');
});

test('review: HR cannot approve; the reviewer sets the approved amount (not above the applied one), the instalments and the first month; approving fixes the schedule', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 39000, months: 3, deductFrom: '2026-12' })), 201);
  await ok(w.hr('post', `/payroll/loans/${a.id}/submit`));
  await fails(w.hr('post', `/payroll/loans/${a.id}/approve`), 403);
  await fails(w.hr('patch', `/payroll/loans/${a.id}/review`, { approvedAmount: 15000 }), 403);
  expect(await ok(w.api('get', `/payroll/loans/${a.id}`))).toMatchObject({ canApprove: true, canReject: true, canReviewEdit: true, canPay: false });
  await fails(w.api('patch', `/payroll/loans/${a.id}/review`, { approvedAmount: 39001 }), 422, 'APPROVED_MORE_THAN_APPLIED');
  await fails(w.api('patch', `/payroll/loans/${a.id}/review`, { appliedAmount: 100 }), 400, 'VALIDATION_FAILED');
  await fails(w.api('patch', `/payroll/loans/${a.id}/review`, { months: 20 }), 400, 'VALIDATION_FAILED');
  const r = await ok(w.api('patch', `/payroll/loans/${a.id}/review`, { approvedAmount: 15000, months: 2, deductFrom: '2027-01', remarks: 'Half only' }));
  expect(r).toMatchObject({ status: 'IN_REVIEW', applied: '39000.00', approved: '15000.00', months: 2, deductFrom: '2027-01', schedule: { total: '15000.00', rows: [{ label: 'JAN-2027', emi: '7500.00' }, { label: 'FEB-2027', emi: '7500.00' }] } });
  const done = await ok(w.api('post', `/payroll/loans/${a.id}/approve`));
  expect(done).toMatchObject({ status: 'APPROVED', statusText: 'Approved', applied: '39000.00', approved: '15000.00', salaryAtApproval: '42000.00', approval: { by: expect.any(String) },
    paid: '0.00', balance: '0.00', toPay: '15000.00', canPay: true, canEdit: false, canApprove: false, canWithdraw: false });
  await fails(w.api('post', `/payroll/loans/${a.id}/approve`), 422, 'NOT_IN_REVIEW');
  await fails(w.hr('patch', `/payroll/loans/${a.id}`, { months: 4 }), 422, 'LOAN_CLOSED');
  await fails(w.hr('delete', `/payroll/loans/${a.id}`), 422, 'LOAN_CLOSED');
  // without the reviewer's amount the applied one is approved
  const b = await approved(w, { employeeId: w.zamin.id, appliedAmount: 10000, months: 4 });
  expect(b).toMatchObject({ applied: '10000.00', approved: '10000.00', emi: '2500.00' });
  // a salary that fell below the loan stops the approval
  const c = await ok(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 40000 })), 201);
  await ok(w.hr('post', `/payroll/loans/${c.id}/submit`));
  await ok(w.api('patch', `/payroll/employees/${w.faizan.id}`, { basicSalary: 20000 }));
  const low = await fails(w.api('post', `/payroll/loans/${c.id}/approve`), 422, 'LOAN_MORE_THAN_SALARY');
  expect(low.details).toEqual({ salary: '20000.00', amount: '40000.00' });
  // the employee's earlier approved loan is not touched, and he now has two loans on his card
  const seen = await ok(w.api('get', `/payroll/loans/${c.id}`));
  expect(seen.previousLoans.map((p) => [p.appId, p.status, p.applied])).toEqual([['00001', 'APPROVED', '39000.00']]);
});

test('reject needs a reason; HR re-opens a rejected application and sends it again', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/loans', loan(w)), 201);
  await ok(w.hr('post', `/payroll/loans/${a.id}/submit`));
  await fails(w.api('post', `/payroll/loans/${a.id}/reject`, {}), 400, 'VALIDATION_FAILED');
  await fails(w.hr('post', `/payroll/loans/${a.id}/reject`, { reason: 'Not allowed' }), 403);
  const r = await ok(w.api('post', `/payroll/loans/${a.id}/reject`, { reason: 'Too many loans already' }));
  expect(r).toMatchObject({ status: 'REJECTED', statusText: 'Rejected', approval: { reason: 'Too many loans already' }, canReopen: true, canEdit: false, approved: null });
  const other = await ok(w.hr('post', '/payroll/loans', loan(w, { appliedAmount: 1000 })), 201);
  await fails(w.hr('post', `/payroll/loans/${a.id}/reopen`), 422, 'LOAN_APPLICATION_OPEN');
  await ok(w.hr('delete', `/payroll/loans/${other.id}`), 204);
  expect(await ok(w.hr('post', `/payroll/loans/${a.id}/reopen`))).toMatchObject({ status: 'DRAFT', approval: null, canEdit: true });
  await fails(w.hr('post', `/payroll/loans/${a.id}/reopen`), 422, 'NOT_REJECTED');
  await ok(w.hr('post', `/payroll/loans/${a.id}/submit`));
});

test('attachments: up to five JPG / PNG / PDF files while it is a draft, read back with the login', async () => {
  const w = await setup();
  const a = await ok(w.hr('post', '/payroll/loans', loan(w)), 201);
  const up = (body, type = 'image/jpeg', name = 'guarantee.jpg') => request(app).post(`/api/v1/payroll/loans/${a.id}/attachments`).set({ Authorization: `Bearer ${w.hrToken}`, 'Content-Type': type, 'X-File-Name': name }).send(body);
  const first = await up(JPG);
  expect(first.status).toBe(201);
  expect(first.body.attachments).toHaveLength(1);
  expect(first.body.attachments[0]).toMatchObject({ key: expect.stringMatching(/^ATT_[0-9a-f]{10}$/), fileName: 'guarantee.jpg', mimeType: 'image/jpeg', size: JPG.length });
  expect((await up(Buffer.from('not a picture'), 'application/octet-stream')).body.error.code).toBe('FILE_TYPE');
  expect((await up(Buffer.alloc(0))).status).toBe(422);
  for (let i = 0; i < 4; i += 1) expect((await up(JPG)).status).toBe(201);
  expect((await up(JPG)).body.error.code).toBe('TOO_MANY_FILES');
  const key = first.body.attachments[0].key;
  const dl = await request(app).get(`/api/v1/payroll/loans/${a.id}/attachments/${key}`).set({ Authorization: `Bearer ${w.hrToken}` }).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  expect(dl.status).toBe(200);
  expect(dl.body.equals(JPG)).toBe(true);
  expect((await request(app).get(`/api/v1/payroll/loans/${a.id}/attachments/${key}`)).status).toBe(401);
  expect((await request(app).get(`/api/v1/payroll/loans/${a.id}/attachments/nope`).set({ Authorization: `Bearer ${w.hrToken}` })).status).toBe(400);
  expect((await ok(w.hr('delete', `/payroll/loans/${a.id}/attachments/${key}`))).attachments).toHaveLength(4);
  await fails(w.hr('delete', `/payroll/loans/${a.id}/attachments/${key}`), 404, 'NOT_FOUND');
  await ok(w.hr('post', `/payroll/loans/${a.id}/submit`));
  expect((await up(JPG)).body.error.code).toBe('LOAN_IN_REVIEW');
  await ok(w.hr('post', `/payroll/loans/${a.id}/withdraw`));
  await ok(w.hr('delete', `/payroll/loans/${a.id}`), 204);
  const left = await sequelize.query(`SELECT count(*)::int AS n FROM payroll_files WHERE "ownerType" = 'LOAN'`, { type: sequelize.QueryTypes.SELECT });
  expect(left[0].n).toBe(0);
});

test('the loan voucher: pays an approved loan from the bank (Debit Employee Loans, Credit Bank), in pieces, never above the approved amount; the balance follows', async () => {
  const w = await setup();
  const l = await approved(w, { appliedAmount: 30000, months: 3 }, { approvedAmount: 25000 });
  expect(l.toPay).toBe('25000.00');
  const draftLoan = await ok(w.hr('post', '/payroll/loans', loan(w, { employeeId: w.zamin.id, appliedAmount: 5000 })), 201);

  const v = (body) => w.accountant('post', '/employee-loan-vouchers', body);
  const send = async (body, status = 201) => ok(v(body), status);
  const options = await ok(w.accountant('get', '/employee-loan-vouchers/options'));
  expect(options.payFromAccounts.map((a) => a.code)).toEqual(['1101', '1102']);
  const pickable = await ok(w.accountant('get', '/employee-loan-vouchers/loans'));
  expect(pickable.data).toEqual([expect.objectContaining({ loanId: l.id, appId: '00001', approved: 25000, paid: 0, toPay: 25000, months: 3, employee: expect.objectContaining({ code: 514, name: 'MUHAMMAD FAIZAN' }) })]);

  await fails(v(payload(w, draftLoan.id)), 422, 'LOAN_NOT_APPROVED');
  await fails(v(payload(w, l.id, { amount: 25000.01 })), 422, 'AMOUNT_MORE_THAN_LOAN');
  await fails(v(payload(w, l.id, { payFromAccountId: w.receivable.id })), 422, 'NOT_BANK_OR_CASH');
  await fails(v(payload(w, l.id, { voucherDate: '2020-01-01' })), 422, 'VOUCHER_BEFORE_APPLICATION');
  await fails(v(payload(w, l.id, { amount: 0 })), 422, 'BAD_AMOUNT');
  await fails(v({ loanId: l.id }), 400, 'VALIDATION_FAILED');
  await fails(v(payload(w, '8f3c1a2e-1111-4222-8333-444455556666')), 404, 'NOT_FOUND');

  const v1 = await send(payload(w, l.id, { amount: 10000, notes: 'First part' }));
  expect(v1).toMatchObject({ voucherNo: 1, voucherLabel: 'ELV-00001', status: 'DRAFT', amount: 10000, refNo: '11934', notes: 'First part', canConfirm: true, canEdit: true,
    paymentMode: 'ONLINE', payFrom: { code: '1102' }, loan: { appId: '00001', approved: 25000 }, employee: { code: 514 } });
  // a draft already counts: the two vouchers cannot both take the last rupee
  const e = await fails(v(payload(w, l.id, { amount: 15000.01 })), 422, 'AMOUNT_MORE_THAN_LOAN');
  expect(e.details).toEqual({ approved: 25000, alreadyPaid: 10000, remaining: 15000 });
  const v2 = await send(payload(w, l.id, { amount: 15000, paymentMode: 'CHEQUE', chequeNo: '778899', chequeDate: TODAY }));
  expect((await ok(w.accountant('patch', `/employee-loan-vouchers/${v2.id}`, { amount: 14000 }))).amount).toBe(14000);
  await fails(w.accountant('patch', `/employee-loan-vouchers/${v2.id}`, { amount: 15001 }), 422, 'AMOUNT_MORE_THAN_LOAN');

  // nothing is paid until confirmed; the loan shows the drafts
  let d = await ok(w.api('get', `/payroll/loans/${l.id}`));
  expect(d).toMatchObject({ paid: '0.00', balance: '0.00', toPay: '25000.00', draftPayments: '24000.00', canPay: true });
  expect(d.payments.map((p) => [p.voucherLabel, p.amount, p.status])).toEqual([['ELV-00001', '10000.00', 'DRAFT'], ['ELV-00002', '14000.00', 'DRAFT']]);

  // confirm: the default account Employee Loans is made on the way
  const c1 = await ok(w.accountant('post', `/employee-loan-vouchers/${v1.id}/confirm`));
  expect(c1).toMatchObject({ status: 'CONFIRMED', statusText: 'Confirmed', canEdit: false, canUnconfirm: true, confirmedBy: { name: expect.any(String) } });
  const entry = await ok(w.accountant('get', `/employee-loan-vouchers/${v1.id}/accounts-entry`));
  expect(entry).toMatchObject({ posted: true, voucherLabel: 'ELV-00001' });
  expect(entry.current.lines.map((x) => [x.account.name, x.debit, x.credit, x.partyId])).toEqual([['Employee Loans', 10000, 0, null], ['Bank Account', 0, 10000, null]]);
  expect(entry.current.sourceType).toBe('EMPLOYEE_LOAN_VOUCHER');
  const defaults = await ok(w.api('get', '/accounts/defaults'));
  const role = defaults.data.find((x) => x.key === 'EMPLOYEE_LOANS');
  expect(role).toMatchObject({ group: 'PAYROLL', groupText: 'Payroll', title: 'Employee Loans', accountType: 'ASSET', status: 'SET', account: { name: 'Employee Loans', hasEntries: true }, usedBy: ['Employee loan voucher', 'Payroll'] });
  const acc = await ok(w.api('get', `/accounts/${role.account.id}`));
  expect(acc).toMatchObject({ controlType: 'EMPLOYEE_LOANS', isSystem: true, accountType: 'ASSET' });
  await fails(w.accountant('patch', `/employee-loan-vouchers/${v1.id}`, { amount: 1 }), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('delete', `/employee-loan-vouchers/${v1.id}`), 422, 'VOUCHER_CONFIRMED');
  await fails(w.accountant('post', `/employee-loan-vouchers/${v1.id}/confirm`), 422, 'ALREADY_CONFIRMED');
  await ok(w.accountant('post', `/employee-loan-vouchers/${v2.id}/confirm`));

  d = await ok(w.api('get', `/payroll/loans/${l.id}`));
  expect(d).toMatchObject({ paid: '24000.00', deducted: '0.00', balance: '24000.00', toPay: '1000.00', draftPayments: '0.00', canPay: true, employee: { currentLoan: '24000.00' } });
  expect(d.payments.map((p) => p.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
  expect(d.payments[1]).toMatchObject({ paidFrom: { code: '1102' }, refNo: '11934', amount: '14000.00' });
  const rest = await send(payload(w, l.id, { amount: 1000 }));
  await ok(w.accountant('post', `/employee-loan-vouchers/${rest.id}/confirm`));
  d = await ok(w.api('get', `/payroll/loans/${l.id}`));
  expect(d).toMatchObject({ paid: '25000.00', balance: '25000.00', toPay: '0.00', canPay: false });
  expect((await ok(w.accountant('get', '/employee-loan-vouchers/loans'))).total).toBe(0);
  const list = await ok(w.accountant('get', '/employee-loan-vouchers'));
  expect(list).toMatchObject({ total: 3, summary: { vouchers: 3, amount: 25000, confirmed: 25000 } });
  expect(list.data.map((x) => x.voucherNo)).toEqual([3, 2, 1]);
  for (const [query, n] of [['status=DRAFT', 0], ['search=faizan', 3], ['search=778899', 1], ['search=2', 1], [`loanId=${l.id}`, 3], [`employeeId=${w.zamin.id}`, 0], ['search=11934', 3]]) {
    expect([query, (await ok(w.accountant('get', `/employee-loan-vouchers?${query}`))).total]).toEqual([query, n]);
  }

  // the tabs of the application list: Balance = paid out and not repaid
  expect(await ok(w.api('get', '/payroll/loans/summary'))).toEqual({ total: 2, draft: 1, inReview: 0, rejected: 0, approved: 1, balance: 1 });
  const bal = await ok(w.api('get', '/payroll/loans?balanceOnly=true'));
  expect(bal).toMatchObject({ total: 1, totals: { applied: '30000.00', approved: '25000.00', balance: '25000.00' } });
  expect(bal.data[0].id).toBe(l.id);
  expect((await ok(w.api('get', '/payroll/loans'))).totals).toMatchObject({ applied: '35000.00', approved: '25000.00' });

  // the payroll will write the deductions: the balance follows them, and a voucher that was already recovered from cannot be taken back
  await sequelize.query(`INSERT INTO payroll_loan_deductions ("companyId", "loanId", month, amount) VALUES (:c, :l, '2026-12-01', 8000)`, { replacements: { c: w.company.id, l: l.id } });
  d = await ok(w.api('get', `/payroll/loans/${l.id}`));
  expect(d).toMatchObject({ paid: '25000.00', deducted: '8000.00', balance: '17000.00' });
  expect(d.deductions).toEqual([expect.objectContaining({ month: '2026-12', amount: '8000.00', source: 'PAYROLL' })]);
  await ok(w.accountant('post', `/employee-loan-vouchers/${rest.id}/unconfirm`, { reason: 'wrong account' })); // 24,000 stays paid, 8,000 deducted: fine
  const back = await ok(w.accountant('get', `/employee-loan-vouchers/${rest.id}/accounts-entry`));
  expect(back).toMatchObject({ status: 'DRAFT', posted: false });
  expect(back.entries).toHaveLength(2); // the entry and its reversal stay in the books
  await ok(w.accountant('delete', `/employee-loan-vouchers/${rest.id}`), 204);
});

test('a voucher cannot be moved to draft once the payroll recovered more than what would stay paid out', async () => {
  const w = await setup();
  const l = await approved(w, { appliedAmount: 20000, months: 2 });
  const v = await ok(w.accountant('post', '/employee-loan-vouchers', payload(w, l.id, { amount: 20000 })), 201);
  await ok(w.accountant('post', `/employee-loan-vouchers/${v.id}/confirm`));
  await sequelize.query(`INSERT INTO payroll_loan_deductions ("companyId", "loanId", month, amount) VALUES (:c, :l, '2026-12-01', 10000)`, { replacements: { c: w.company.id, l: l.id } });
  await fails(w.accountant('post', `/employee-loan-vouchers/${v.id}/unconfirm`), 422, 'LOAN_ALREADY_DEDUCTED');
  expect((await ok(w.api('get', `/payroll/loans/${l.id}`))).balance).toBe('10000.00');
});

test('access: reading needs a payroll service, HR writes the application, the accountant pays; another company sees nothing', async () => {
  const w = await setup();
  const l = await approved(w);
  const viewer = await makeUser({ userType: 'USER', companyId: w.company.id });
  await grant(viewer, 'PAYROLL_REPORTS', 'VIEW');
  const v = asUser(viewer);
  await ok(v('get', `/payroll/loans/${l.id}`));
  await ok(v('get', '/payroll/loans/summary'));
  expect((await v('post', '/payroll/loans', loan(w))).status).toBe(403);
  expect((await v('get', '/employee-loan-vouchers')).status).toBe(403);
  expect((await w.hr('get', '/employee-loan-vouchers')).status).toBe(403); // HR does not pay
  expect((await w.accountant('post', '/payroll/loans', loan(w))).status).toBe(403); // the accountant does not make applications
  const other = await setup();
  await fails(other.api('get', `/payroll/loans/${l.id}`), 404, 'NOT_FOUND');
  await fails(other.accountant('post', '/employee-loan-vouchers', payload(other, l.id)), 404, 'NOT_FOUND');
  expect((await ok(other.api('get', '/payroll/loans'))).total).toBe(0);
  // the employee with a loan application cannot be deleted
  await fails(w.api('delete', `/payroll/employees/${w.faizan.id}`), 422, 'IN_USE');
});
