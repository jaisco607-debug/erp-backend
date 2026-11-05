// The three vouchers of the accounting module. Company people only: VIEW reads, FULL adds / edits / deletes / confirms.
//   /api/v1/payment-vouchers   service ACC_PAYMENTS   pay a vendor
//   /api/v1/receipt-vouchers   service ACC_RECEIPTS   receive from a customer
//   /api/v1/journal-vouchers   service ACC_JOURNAL    general journal voucher
//   /api/v1/contra-vouchers    service ACC_CONTRA     a customer's money applied straight to a vendor's bill
//   /api/v1/employee-loan-vouchers  service ACC_PAYMENTS  the money paid out to an employee for an approved loan
//   /api/v1/employee-advance-vouchers  service ACC_PAYMENTS  the money paid out to an employee for an advance of the payroll
//   /api/v1/salary-payment-vouchers service ACC_PAYMENTS  the salary paid to the employees of approved payslips
//   /api/v1/salary-tax-vouchers      service ACC_PAYMENTS  the income tax withheld from the salaries, paid to the government
//   /api/v1/eobi-vouchers            service ACC_PAYMENTS  the EOBI paid for one location of a list
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/voucherValidator');
const payments = require('../services/paymentVoucherService');
const receipts = require('../services/receiptVoucherService');
const journals = require('../services/journalVoucherService');
const contras = require('../services/contraVoucherService');
const loanVouchers = require('../services/employeeLoanVoucherService');
const advanceVouchers = require('../services/employeeAdvanceVoucherService');
const salaryVouchers = require('../services/salaryPaymentVoucherService');
const eobiVouchers = require('../services/eobiVoucherService');
const salaryTaxVouchers = require('../services/salaryTaxVoucherService');

function voucherRouter(serviceCode, service, rules, extra) {
  const view = requireService(serviceCode, 'VIEW');
  const full = requireService(serviceCode, 'FULL');
  const r = express.Router();
  r.use(authenticate);
  r.get('/options', view, async (req, res) => res.json(await service.options(req)));
  for (const [path, rule, handler] of extra) r.get(path, view, validate(rule), async (req, res) => res.json(await service[handler](req, req.validatedQuery)));
  r.get('/', view, validate(rules.list), async (req, res) => res.json(await service.list(req, req.validatedQuery)));
  r.post('/', full, validate(rules.create), async (req, res) => res.status(201).json(await service.create(req, req.body)));
  r.get('/:id', view, validate(rules.get), async (req, res) => res.json(await service.get(req, req.params.id)));
  r.patch('/:id', full, validate(rules.update), async (req, res) => res.json(await service.update(req, req.params.id, req.body)));
  r.delete('/:id', full, validate(rules.get), async (req, res) => {
    await service.remove(req, req.params.id);
    res.status(204).end();
  });
  r.post('/:id/confirm', full, validate(rules.get), async (req, res) => res.json(await service.confirm(req, req.params.id)));
  r.post('/:id/unconfirm', full, validate(rules.unconfirm), async (req, res) => res.json(await service.unconfirm(req, req.params.id, req.body)));
  r.get('/:id/accounts-entry', view, validate(rules.get), async (req, res) => res.json(await service.accountsEntry(req, req.params.id)));
  return r;
}

module.exports = {
  payments: voucherRouter('ACC_PAYMENTS', payments, v.payment, [['/bills', v.payment.bills, 'bills']]),
  receipts: voucherRouter('ACC_RECEIPTS', receipts, v.receipt, [['/invoices', v.receipt.invoices, 'invoices']]),
  journals: voucherRouter('ACC_JOURNAL', journals, v.journal, []),
  contras: voucherRouter('ACC_CONTRA', contras, v.contra, [['/invoices', v.contra.invoices, 'invoices'], ['/bills', v.contra.bills, 'bills']]),
  // the money paid out to an employee for an approved loan: it is a payment, so it uses the Payment Vouchers service
  loans: voucherRouter('ACC_PAYMENTS', loanVouchers, v.loan, [['/loans', v.loan.loans, 'loans']]),
  // the money paid out to an employee for an advance of the payroll: also a payment
  advances: voucherRouter('ACC_PAYMENTS', advanceVouchers, v.advance, [['/advances', v.advance.advances, 'advances']]),
  // the salary paid to the employees: also a payment
  salary: voucherRouter('ACC_PAYMENTS', salaryVouchers, v.salary, [['/slips', v.salary.slips, 'slips']]),
  // the EOBI paid per location of a list
  salaryTax: voucherRouter('ACC_PAYMENTS', salaryTaxVouchers, v.salaryTax, [['/slips', v.salaryTax.slips, 'slips']]),
  eobi: voucherRouter('ACC_PAYMENTS', eobiVouchers, v.eobi, [['/locations', v.eobi.locations, 'locations']]),
};
