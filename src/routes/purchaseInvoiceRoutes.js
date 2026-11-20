// /api/v1/purchase-invoices  -  Purchase Invoice (service ACC_PURCHASES). Company people only: VIEW reads, FULL adds / edits / deletes / approves.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/purchaseInvoiceValidator');
const c = require('../controllers/purchaseInvoiceController');

const SERVICE = 'ACC_PURCHASES';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');

const router = express.Router();
router.use(authenticate);
router.get('/options', view, c.options);
router.get('/credit/:id', view, validate(v.get), c.credit);
router.get('/inwards', view, validate(v.inwards), c.inwards);
router.get('/sizing-inwards', view, validate(v.sizingInwards), c.sizingInwards); // the weaving sizing receipts of a vendor that can go on a sizing invoice
router.get('/store-yarn-inwards', view, validate(v.storeYarnInwards), c.storeYarnInwards); // the store yarn inwards (yarn bought) of a vendor that can go on a store yarn invoice
router.get('/sizing-batches', view, validate(v.sizingBatches), c.sizingBatches); // the confirmed sizing batches of a sizing party that can go on a sizing batch invoice
router.get('/fabric-inwards', view, validate(v.fabricInwards), c.fabricInwards); // the store fabric inwards (cloth bought) of a vendor that can go on a fabric invoice
router.get('/yarn-inwards', view, validate(v.yarnInwards), c.yarnInwards); // the weaving yarn bought from a vendor that can go on a yarn invoice
router.get('/', view, validate(v.list), c.list);
router.post('/', full, validate(v.create), c.create);
router.get('/:id', view, validate(v.get), c.get);
router.patch('/:id', full, validate(v.update), c.update);
router.delete('/:id', full, validate(v.get), c.remove);
router.post('/:id/approve', full, validate(v.get), c.approve);
router.post('/:id/unapprove', full, validate(v.unapprove), c.unapprove);
router.get('/:id/accounts-entry', view, validate(v.get), c.accountsEntry);

module.exports = router;
