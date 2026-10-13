// /api/v1/auth  -  the one login window for super admins, client admins and users.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const loginLimiter = require('../middlewares/loginLimiter');
const v = require('../validators/authValidator');
const c = require('../controllers/authController');

const router = express.Router();

router.post('/login', loginLimiter, validate(v.login), c.login);
router.post('/refresh', loginLimiter, validate(v.refresh), c.refresh);
router.post('/logout', validate(v.refresh), c.logout);
router.post('/logout-all', authenticate, c.logoutAll);
router.get('/me', authenticate, c.me);
router.post('/change-password', authenticate, validate(v.changePassword), c.changePassword);

module.exports = router;
