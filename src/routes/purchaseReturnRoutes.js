// /api/v1/purchase-returns  -  Purchase Return Invoice (debit note), service ACC_PURCHASES. VIEW reads, FULL adds / edits / deletes / approves.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/purchaseReturnValidator');
const c = require('../controllers/purchaseReturnController');

const SERVICE = 'ACC_PURCHASES';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');

const router = express.Router();
router.use(authenticate);
router.get('/vendor-returns', view, validate(v.vendorReturns), c.vendorReturns); // the vendor's returns (stock sent back) that can go on a return invoice
router.get('/', view, validate(v.list), c.list);
router.post('/', full, validate(v.create), c.create);
router.get('/:id', view, validate(v.get), c.get);
router.patch('/:id', full, validate(v.update), c.update);
router.delete('/:id', full, validate(v.get), c.remove);
router.post('/:id/approve', full, validate(v.get), c.approve);
router.post('/:id/unapprove', full, validate(v.unapprove), c.unapprove);
router.get('/:id/accounts-entry', view, validate(v.get), c.accountsEntry);

module.exports = router;
