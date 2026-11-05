// /api/v1/sales-invoices  -  Sales Invoice (service ACC_SALES). Company people only: VIEW reads, FULL adds / edits / deletes / approves.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/salesInvoiceValidator');
const c = require('../controllers/salesInvoiceController');

const SERVICE = 'ACC_SALES';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');

const router = express.Router();
router.use(authenticate);
router.get('/options', view, c.options);
router.get('/credit/:id', view, validate(v.get), c.credit);
router.get('/gate-passes', view, validate(v.gatePasses), c.gatePasses);
router.get('/', view, validate(v.list), c.list);
router.post('/', full, validate(v.create), c.create);
router.get('/:id', view, validate(v.get), c.get);
router.patch('/:id', full, validate(v.update), c.update);
router.delete('/:id', full, validate(v.get), c.remove);
router.post('/:id/approve', full, validate(v.get), c.approve);
router.post('/:id/unapprove', full, validate(v.unapprove), c.unapprove);
router.get('/:id/accounts-entry', view, validate(v.get), c.accountsEntry);

module.exports = router;
