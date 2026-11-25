const { app, request, clean, makeUser, makeCompany, loginAs, sequelize } = require('./helpers');
const { Service, CompanyService } = require('../src/models');

jest.setTimeout(240000);
beforeEach(clean);

const SERVICES = ['CHEMICAL_STORE', 'GENERAL_STORE', 'ACC_COA', 'ACC_PURCHASES', 'ACC_PAYMENTS', 'ACC_REPORTS'];

async function setup() {
  const company = await makeCompany();
  for (const code of SERVICES) await CompanyService.create({ companyId: company.id, serviceId: (await Service.findOne({ where: { code } })).id });
  const admin = await makeUser({ userType: 'CLIENT_ADMIN', companyId: company.id });
  const auth = { Authorization: `Bearer ${(await loginAs(admin)).accessToken}` };
  return { company, api: (m, url, body) => request(app)[m](`/api/v1${url}`).set(auth).send(body) };
}
const ok = async (p, status = 200) => { const r = await p; expect([r.status, r.status === status ? '' : JSON.stringify(r.body).slice(0, 300)]).toEqual([status, '']); return r.body; };
const fails = async (p, status, code) => { const r = await p; expect([r.status, r.body.error && r.body.error.code]).toEqual([status, code]); };
const tb = (w) => ok(w.api('get', '/accounting/trial-balance?dateFrom=2026-10-01&dateTo=2026-10-31'));
const row = (t, name) => t.rows.find((r) => r.name === name);

// owner 2026-11-24: 120 kg bought at 500 = 60,000 and invoiced; 60 kg go back: the bill must become 30,000
test('purchase return invoice: linked to the bill, gate pass and challan on the return, entries reversed, the bill balance falls', async () => {
  const w = await setup();
  const vendor = await ok(w.api('post', '/vendors', { name: 'NEXUS CHEMICAL' }), 201);
  const soda = await ok(w.api('post', '/stores/chemical/items', { name: 'Caustic Soda', unit: 'KG' }), 201);
  const inward = (body) => ok(w.api('post', '/stores/chemical/inwards', { vendorId: vendor.id, approve: true, ...body }), 201);
  const inw = await inward({ inwardDate: '2026-10-10', lines: [{ itemId: soda.id, qty: 120, rate: 500 }] });
  const loose = await inward({ inwardDate: '2026-10-11', lines: [{ itemId: soda.id, qty: 10, rate: 100 }] }); // never put on an invoice

  const bill = await ok(w.api('post', '/purchase-invoices', { vendorId: vendor.id, inwardIds: [inw.id], invoiceDate: '2026-10-20' }), 201);
  expect(bill.net).toBe(60000);

  // the goods go back: a gate pass and a delivery challan of ours are numbered
  const sendBack = (body) => ok(w.api('post', '/stores/chemical/vendor-returns', { returnDate: '2026-10-25', vendorId: vendor.id, reason: 'DAMAGED', ...body }), 201);
  const ret = await sendBack({ vehicleNo: 'LEA-123', driverName: 'Aslam', lines: [{ inwardLineId: inw.lines[0].id, qty: 60 }] });
  expect(ret).toMatchObject({ totalValue: 30000, gatePassText: 'OP-00001', challanText: 'RDC-00001', vehicleNo: 'LEA-123', driverName: 'Aslam', purchaseReturn: null });
  expect(ret.lines[0]).toMatchObject({ purchaseInvoiceId: bill.id, purchaseInvoiceLabel: bill.voucherLabel });
  const ret2 = await sendBack({ lines: [{ inwardLineId: loose.lines[0].id, qty: 5 }] });
  expect([ret2.gatePassText, ret2.challanText]).toEqual(['OP-00002', 'RDC-00002']);

  // while the bill is not approved, nothing can be billed; an unbilled purchase cannot either
  let offer = (await ok(w.api('get', `/purchase-returns/vendor-returns?vendorId=${vendor.id}`))).data;
  expect(offer.find((x) => x.vendorReturnId === ret.id)).toMatchObject({ canBill: false, blockedCode: 'INVOICE_NOT_APPROVED' });
  expect(offer.find((x) => x.vendorReturnId === ret2.id)).toMatchObject({ canBill: false, blockedCode: 'NOT_ON_INVOICE' });
  await fails(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret.id] }), 422, 'INVOICE_NOT_APPROVED');
  await fails(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret2.id] }), 422, 'NOT_ON_INVOICE');
  await ok(w.api('post', `/purchase-invoices/${bill.id}/approve`));

  offer = (await ok(w.api('get', `/purchase-returns/vendor-returns?vendorId=${vendor.id}`))).data;
  expect(offer.find((x) => x.vendorReturnId === ret.id)).toMatchObject({ canBill: true, gross: 30000, tax: 0, net: 30000, gatePassText: 'OP-00001', purchaseInvoice: { id: bill.id } });

  // the return invoice: a draft first, it posts nothing
  await fails(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret.id], returnDate: '2026-10-01' }), 422, 'RETURN_BEFORE_INVOICE');
  const pr = await ok(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret.id], returnDate: '2026-10-25', notes: 'leaking drums' }), 201);
  expect(pr).toMatchObject({ voucherLabel: '00001', status: 'UNAPPROVED', gross: 30000, tax: 0, net: 30000, purchaseInvoice: { id: bill.id, net: 60000, balance: 60000 } });
  expect(pr.lines[0]).toMatchObject({ returnText: ret.returnText, gatePassText: 'OP-00001', challanText: 'RDC-00001', qty: 60, rate: 500, amount: 30000 });
  expect(pr.vendorReturns[0]).toMatchObject({ gatePassText: 'OP-00001', vehicleNo: 'LEA-123' });
  expect((await ok(w.api('get', `/purchase-invoices/${bill.id}`))).returns).toMatchObject([{ voucherLabel: '00001', status: 'UNAPPROVED', net: 30000 }]);
  expect(row(await tb(w), 'Accounts Payable')).toMatchObject({ closingCredit: '60000.00' });
  await fails(w.api('post', '/purchase-returns', { vendorId: vendor.id, vendorReturnIds: [ret.id] }), 422, 'ALREADY_INVOICED');
  await fails(w.api('post', `/stores/chemical/vendor-returns/${ret.id}/cancel`, { reason: 'by mistake' }), 422, 'RETURN_INVOICED');
  expect((await ok(w.api('get', `/stores/chemical/vendor-returns/${ret.id}`))).purchaseReturn).toMatchObject({ voucherLabel: '00001', status: 'UNAPPROVED' });

  // approved: Debit Accounts Payable 30,000, Credit Purchases 30,000; the bill is 30,000 now
  const done = await ok(w.api('post', `/purchase-returns/${pr.id}/approve`));
  expect(done).toMatchObject({ status: 'APPROVED', appliedAmount: 30000, unappliedAmount: 0, canUnapprove: true, canEdit: false });
  const after = await ok(w.api('get', `/purchase-invoices/${bill.id}`));
  expect(after).toMatchObject({ net: 60000, paid: 0, returnedAmount: 30000, balance: 30000, canUnapprove: false });
  await fails(w.api('post', `/purchase-invoices/${bill.id}/unapprove`, {}), 422, 'HAS_RETURNS');
  await fails(w.api('post', `/purchase-returns/${pr.id}/approve`), 422, 'ALREADY_APPROVED');
  await fails(w.api('patch', `/purchase-returns/${pr.id}`, { notes: 'x' }), 422, 'RETURN_APPROVED');
  const t = await tb(w);
  expect(row(t, 'Purchases')).toMatchObject({ periodDebit: '60000.00', periodCredit: '30000.00', closingDebit: '30000.00' });
  expect(row(t, 'Accounts Payable')).toMatchObject({ periodDebit: '30000.00', periodCredit: '60000.00', closingCredit: '30000.00' });
  // the payment voucher offers the smaller amount
  const bills = (await ok(w.api('get', `/payment-vouchers/bills?vendorId=${vendor.id}`))).data;
  expect(bills).toHaveLength(1);
  expect(Number(bills[0].net) - Number(bills[0].paid)).toBe(30000);
  // the vendor ledger shows both documents
  const led = await ok(w.api('get', `/accounting/party-ledger?partyType=VENDOR&partyId=${vendor.id}&dateFrom=2026-10-01&dateTo=2026-10-31`));
  expect(JSON.stringify(led)).toContain('Purchase return');
  expect(await ok(w.api('get', `/purchase-returns/${pr.id}/accounts-entry`))).toMatchObject({ posted: true, status: 'APPROVED' });

  // un-approve: everything goes back
  await ok(w.api('post', `/purchase-returns/${pr.id}/unapprove`, { reason: 'wrong qty' }));
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ paid: 0, returnedAmount: 0, balance: 60000, canUnapprove: true });
  expect(row(await tb(w), 'Accounts Payable')).toMatchObject({ closingCredit: '60000.00' });

  // the bill was partly paid (50,000) before the return is approved: only the 10,000 left can be taken off the bill, the rest stays a debit balance of the vendor
  await sequelize.query('UPDATE purchase_invoices SET "paidAmount" = 50000 WHERE id = :id', { replacements: { id: bill.id } });
  const part = await ok(w.api('post', `/purchase-returns/${pr.id}/approve`));
  expect(part).toMatchObject({ status: 'APPROVED', net: 30000, appliedAmount: 10000, unappliedAmount: 20000 });
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ paid: 50000, returnedAmount: 10000, balance: 0 });
  await ok(w.api('post', `/purchase-returns/${pr.id}/unapprove`, {}));
  expect(await ok(w.api('get', `/purchase-invoices/${bill.id}`))).toMatchObject({ paid: 50000, returnedAmount: 0, balance: 10000 });

  // a draft can be deleted; then the return can be billed again
  const gone = await w.api('delete', `/purchase-returns/${pr.id}`);
  expect(gone.status).toBe(204);
  expect((await ok(w.api('get', `/purchase-returns/vendor-returns?vendorId=${vendor.id}`))).data.find((x) => x.vendorReturnId === ret.id)).toMatchObject({ canBill: true });
});
