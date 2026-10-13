// /api/v1/audit-logs  -  super admins see everything. (Client admins will see their own company's log in step 2c.)
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/auditValidator');
const c = require('../controllers/auditController');

const router = express.Router();
router.use(authenticate, requireUserType('SUPER_ADMIN'));

router.get('/', validate(v.list), c.list);

module.exports = router;
