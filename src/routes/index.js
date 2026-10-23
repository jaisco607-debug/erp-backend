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

// Modules, mounted under /api/v1 as they are built.
router.use('/v1/auth', require('./authRoutes'));
router.use('/v1/super-admins', require('./superAdminRoutes'));
router.use('/v1/audit-logs', require('./auditRoutes'));
router.use('/v1/companies', require('./companyRoutes'));
router.use('/v1/services', require('./serviceRoutes'));
router.use('/v1/users', require('./companyUserRoutes'));
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

module.exports = router;
