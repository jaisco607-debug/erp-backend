// The list of all API routes. Each module adds its own routes file here.
const express = require('express');
const { sequelize } = require('../config/database');

const router = express.Router();

// For monitoring: answers ok only when the database answers too.
router.get('/health', async (req, res) => {
  try {
    await sequelize.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    req.log.error({ err }, 'Health check: database not reachable');
    res.status(503).json({ status: 'database_unavailable' });
  }
});

// Edit locks: a write on a record somebody else is editing answers 423 before it reaches its route.
router.use(require('../middlewares/editLockGuard'));

// Modules, mounted under /api/v1 as they are built.
router.use('/v1/auth', require('./authRoutes'));
router.use('/v1/locks', require('./lockRoutes'));
router.use('/v1/super-admins', require('./superAdminRoutes'));
router.use('/v1/audit-logs', require('./auditRoutes'));
router.use('/v1/companies', require('./companyRoutes'));
router.use('/v1/services', require('./serviceRoutes'));
router.use('/v1/users', require('./companyUserRoutes'));
router.use('/v1/admin/users', require('./adminUserRoutes'));
const grey = require('./greyRoutes');
router.use('/v1/customers', grey.customers);
router.use('/v1/qualities', grey.qualities);
router.use('/v1/grey-lots', grey.lots);
router.use('/v1/so-cards', require('./soCardRoutes'));
router.use('/v1/colours', grey.colours);
router.use('/v1/jobs', require('./jobRoutes'));
router.use('/v1/departments', require('./departmentRoutes'));
const store = require('./storeRoutes');
router.use('/v1/vendors', store.vendors);
router.use('/v1/stores', store.stores);
router.use('/v1/reports', require('./reportRoutes'));
router.use('/v1/accounts', require('./accountRoutes'));
router.use('/v1/accounting', require('./accountingRoutes'));
router.use('/v1/payroll', require('./payrollRoutes'));
router.use('/v1/department-settings', require('./departmentSettingsRoutes'));
router.use('/v1/sales-invoices', require('./salesInvoiceRoutes'));
router.use('/v1/purchase-invoices', require('./purchaseInvoiceRoutes'));
const vouchers = require('./voucherRoutes');
router.use('/v1/payment-vouchers', vouchers.payments);
router.use('/v1/receipt-vouchers', vouchers.receipts);
router.use('/v1/journal-vouchers', vouchers.journals);
router.use('/v1/contra-vouchers', vouchers.contras);
router.use('/v1/employee-loan-vouchers', vouchers.loans);
router.use('/v1/employee-advance-vouchers', vouchers.advances);
router.use('/v1/salary-payment-vouchers', vouchers.salary);
router.use('/v1/eobi-vouchers', vouchers.eobi);
router.use('/v1/salary-tax-vouchers', vouchers.salaryTax);

module.exports = router;
