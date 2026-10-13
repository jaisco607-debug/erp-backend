// /api/v1/super-admins  -  only super admins.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/superAdminValidator');
const c = require('../controllers/superAdminController');

const router = express.Router();
router.use(authenticate, requireUserType('SUPER_ADMIN'));

router.get('/', validate(v.list), c.list);
// The login code all super admins share
router.get('/login-code', c.loginCode);
router.post('/login-code/new', c.newLoginCode);
router.post('/', validate(v.create), c.create);
router.patch('/:id', validate(v.update), c.update);
router.post('/:id/reset-password', validate(v.resetPassword), c.resetPassword);

module.exports = router;
