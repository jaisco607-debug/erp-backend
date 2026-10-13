// /api/v1/services  -  the services the platform offers; only super admins manage them.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/serviceValidator');
const c = require('../controllers/serviceController');

const router = express.Router();
router.use(authenticate, requireUserType('SUPER_ADMIN'));

router.get('/', validate(v.list), c.list);
router.post('/', validate(v.create), c.create);
router.patch('/:id', validate(v.update), c.update);
router.delete('/:id', validate(v.companies), c.remove);
router.get('/:id/companies', validate(v.companies), c.companies);
router.get('/:id/company-options', validate(v.companies), c.companyOptions);
router.post('/:id/companies', validate(v.addCompanies), c.addCompanies);
router.put('/:id/companies', validate(v.setCompanies), c.setCompanies);

module.exports = router;
