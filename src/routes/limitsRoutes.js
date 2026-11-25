// GET /api/v1/limits  -  the usual maximums and the allowed dates, so the screens can set the max of their inputs and show the same
// message as the server. Any signed-in person may read it; nothing here can be changed.
const express = require('express');
const authenticate = require('../middlewares/authenticate');
const LIMITS = require('../config/limits');
const { businessRange } = require('../utils/dates');

const router = express.Router();
router.use(authenticate);
router.get('/', (req, res) => {
  const range = businessRange();
  const old = businessRange(undefined, 40);
  res.json({
    dates: { today: range.today, min: range.min, max: range.max, years: LIMITS.dateYears, joiningDateMin: old.min }, // every document date; joiningDateMin is for the employee's joining date
    numbers: {
      meters: LIMITS.qty, quantity: LIMITS.qty, bags: LIMITS.qty, weight: LIMITS.qty, unitsPerShift: LIMITS.unitsPerShift,
      lotNo: LIMITS.lotNo, lotNoAhead: LIMITS.lotNoAhead, voucherAmount: LIMITS.voucherAmount, basicSalary: LIMITS.basicSalary,
    },
    decimals: { meters: LIMITS.meterDecimals },
    note: 'Rates (price per kg, lb or meter) have no usual maximum.',
  });
});

module.exports = router;
