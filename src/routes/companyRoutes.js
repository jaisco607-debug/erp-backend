// /api/v1/companies  -  only super admins register and manage companies.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/companyValidator');
const c = require('../controllers/companyController');

const router = express.Router();
router.use(authenticate, requireUserType('SUPER_ADMIN'));

router.get('/', validate(v.list), c.list);
router.post('/', validate(v.create), c.create);
router.get('/:id', validate(v.get), c.get);
router.patch('/:id', validate(v.update), c.update);
router.delete('/:id', validate(v.remove), c.remove);
router.post('/:id/admins', validate(v.createAdmin), c.createAdmin);
router.patch('/:id/admins/:userId', validate(v.updateAdmin), c.updateAdmin);
router.delete('/:id/admins/:userId', validate(v.deleteAdmin), c.deleteAdmin);
router.post('/:id/admins/:userId/reset-password', validate(v.resetAdminPassword), c.resetAdminPassword);
router.post('/:id/new-code', validate(v.newCode), c.newCode);
router.put('/:id/services/:serviceId', validate(v.toggleService), c.toggleService);
router.put('/:id/services', validate(v.setServices), c.setServices);

module.exports = router;
