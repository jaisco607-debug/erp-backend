// /api/v1/auth  -  the one login window for super admins, client admins and users.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const loginLimiter = require('../middlewares/loginLimiter');
const v = require('../validators/authValidator');
const c = require('../controllers/authController');
const AppError = require('../utils/AppError');

// A super admin who opened a company is working inside the client admin's account: he must not change its password or end its sessions.
const notWhileCompanyOpened = (req, res, next) => (req.impersonator
  ? next(AppError.rule('COMPANY_OPENED_BY_SUPER_ADMIN', 'Not available while you are viewing a company as super admin'))
  : next());

const router = express.Router();

router.post('/login', loginLimiter, validate(v.login), c.login);
router.post('/refresh', loginLimiter, validate(v.refresh), c.refresh);
router.post('/logout', validate(v.refresh), c.logout);
router.post('/logout-all', authenticate, notWhileCompanyOpened, c.logoutAll);
router.get('/me', authenticate, c.me);
router.post('/change-password', authenticate, notWhileCompanyOpened, validate(v.changePassword), c.changePassword);

module.exports = router;
