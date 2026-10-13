// /api/v1/so-cards  -  SO card (travel card). Company people with the SO Card service:
//   VIEW  lists and details      FULL  make, edit, cancel, send to a department
// Accepting a card is done by the receiving department (client admin, or FULL access to that
// department's service), and so is its incoming list; the service checks that.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const v = require('../validators/soCardValidator');
const c = require('../controllers/soCardController');

const view = requireService('SO_CARD', 'VIEW');
const full = requireService('SO_CARD', 'FULL');
const companyPerson = requireUserType('CLIENT_ADMIN', 'USER');

const router = express.Router();
router.use(authenticate);

router.get('/form-data', view, c.formData);
router.put('/numbering', requireUserType('CLIENT_ADMIN'), full, validate(v.numbering), c.setNumbering);
router.get('/departments', companyPerson, c.departments);
router.get('/available-lots', view, validate(v.availableLots), c.availableLots);
router.get('/incoming', companyPerson, validate(v.incoming), c.incoming);
router.get('/', view, validate(v.list), c.list);
router.post('/', full, validate(v.create), c.create);
router.get('/:id', view, validate(v.get), c.get);
router.patch('/:id', full, validate(v.update), c.update);
router.delete('/:id', full, validate(v.get), c.cancel);
router.put('/:id/confirm', full, validate(v.confirm), c.setConfirmed);
router.post('/:id/send', full, validate(v.send), c.send);
router.post('/:id/accept', companyPerson, validate(v.get), c.accept);

module.exports = router;
