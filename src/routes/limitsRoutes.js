// GET /api/v1/limits           the limits of the numbers and the allowed dates OF THE COMPANY, so the screens can set the max of their inputs and show the same
//                              message as the server. Any signed-in person may read it.
// GET /api/v1/limits/settings  Settings > Limits: what the client admin may change (client admin only)
// PUT /api/v1/limits/settings  change it: one value for all the quantities and / or a value for each one; the date rules. null puts a value back to the standard.
const express = require('express');
const Joi = require('joi');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const validate = require('../middlewares/validate');
const LIMITS = require('../config/limits');
const limitsService = require('../services/limitsService');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const { numbers, windows } = await limitsService.forCompany(req.user.companyId);
  res.json({
    dates: {
      today: windows.today, min: windows.other.min, max: windows.other.max, years: LIMITS.dateYears, joiningDateMin: windows.old.min, openingDate: windows.openingDate,
      // use these for the min / max of a date input: stock and production documents (not after today), vouchers (a few days ahead), everything else
      stock: { ...windows.stock, fields: limitsService.STOCK_DATES },
      voucher: { ...windows.voucher, fields: limitsService.VOUCHER_DATES },
      other: { ...windows.other, fields: limitsService.OTHER_DATES },
    },
    numbers: {
      meters: numbers.meters, beamMeters: numbers.beamMeters, quantity: numbers.storeQty, storeQty: numbers.storeQty, bags: numbers.yarnBags, yarnBags: numbers.yarnBags,
      weight: numbers.bagWeight, bagWeight: numbers.bagWeight, unitsPerShift: numbers.unitsPerShift, lotNo: numbers.lotNo, lotNoAhead: LIMITS.lotNoAhead,
      voucherAmount: numbers.voucherAmount, basicSalary: numbers.basicSalary,
    },
    decimals: { meters: LIMITS.meterDecimals },
    note: 'Rates (price per kg, lb or meter) have no limit.',
  });
});

const hard = (k) => Joi.number().integer().min(1).max(LIMITS.DEFS[k].hardMax).allow(null);
const put = Joi.object({
  allQuantities: Joi.number().integer().min(1).max(LIMITS.QUANTITY_HARD_MAX).allow(null),
  limits: Joi.object(Object.fromEntries(Object.keys(LIMITS.DEFS).map((k) => [k, hard(k)]))),
  openingDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
  maxFutureDaysStock: Joi.number().integer().min(0).max(365),
  maxFutureDaysVouchers: Joi.number().integer().min(0).max(365),
}).min(1);

router.get('/settings', requireUserType('CLIENT_ADMIN'), async (req, res) => res.json(await limitsService.getSettings(req)));
router.put('/settings', requireUserType('CLIENT_ADMIN'), validate({ body: put }), async (req, res) => res.json(await limitsService.saveSettings(req, req.body)));

module.exports = router;
