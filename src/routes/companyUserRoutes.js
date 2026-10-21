// /api/v1/users  -  a client admin manages the users of their own company.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/companyUserValidator');
const c = require('../controllers/companyUserController');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN'));

router.get('/service-options', c.serviceOptions);
router.get('/', validate(v.list), c.list);
router.post('/', validate(v.create), c.create);
router.get('/:id', validate(v.get), c.get);
router.patch('/:id', validate(v.update), c.update);
router.post('/:id/reset-password', validate(v.resetPassword), c.resetPassword);
router.put('/:id/services', validate(v.setServices), c.setServices);

module.exports = router;
