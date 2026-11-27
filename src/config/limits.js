// The usual maximums of the numbers people type (owner 2026-11-24, 2026-11-25): they catch an extra zero, not a real value.
// These are the STANDARD values. Every company may set its own (Settings > Limits, see limitsService): one value for all the quantities, and/or one value for each.
// Rates (the price per kg / lb / meter) have no maximum of their own: only the size the database can hold.
const Joi = require('joi');

// key -> { label, group, default, hardMax }. `hardMax` is what the database column and the old validators could hold: a company cannot go above it.
const DEFS = {
  meters: { label: 'Meters of a thaan, job, fabric inward or machine run', group: 'quantity', unit: 'm', default: 100000, hardMax: 99999999 },
  beamMeters: { label: 'Length of a beam (sizing, half-cut left meters)', group: 'quantity', unit: 'm', default: 100000, hardMax: 99999999 },
  storeQty: { label: 'Quantity of a store / chemical line (also per pack)', group: 'quantity', unit: 'units', default: 100000, hardMax: 999999999 },
  yarnBags: { label: 'Yarn bags in one line', group: 'quantity', unit: 'bags', default: 100000, hardMax: 1000000 },
  bagWeight: { label: 'Weight of a yarn bag or a beam', group: 'quantity', unit: 'lb / kg', default: 100000, hardMax: 1000000 },
  unitsPerShift: { label: 'Units of one loom in one shift', group: 'quantity', unit: 'units', default: 100000, hardMax: 99999999 },
  lotNo: { label: 'Lot number you can type', group: 'other', unit: '', default: 999999, hardMax: 99999999 },
  voucherAmount: { label: 'One line of a voucher or a journal entry', group: 'other', unit: 'Rs', default: 1000000000, hardMax: 9999999999999 },
  basicSalary: { label: 'Basic salary of an employee (per month)', group: 'other', unit: 'Rs', default: 5000000, hardMax: 9999999999 },
};
const QUANTITY_HARD_MAX = 99999999; // the highest value of "one limit for all the quantities"

const LIMITS = {
  qty: DEFS.meters.default, // kept for old callers
  unitsPerShift: DEFS.unitsPerShift.default,
  lotNo: DEFS.lotNo.default,
  lotNoAhead: 1000, // a typed lot number may be at most this far above the next automatic number
  voucherAmount: DEFS.voucherAmount.default,
  basicSalary: DEFS.basicSalary.default,
  meterDecimals: 2, // meters have at most 2 decimals: 10.123 is refused, not rounded to 10.12
  dateYears: 5, // a document date is at most this many years from today (back and ahead)
  maxFutureDaysStock: 0, // stock and production documents: not after today
  maxFutureDaysVouchers: 31, // vouchers, invoices, contracts, delivery dates: at most 31 days ahead
};

// The validators write `.max(R.meters)`: the number is read from the company's limits at the moment of the request (validate middleware gives them as the Joi context).
const REFS = {};
for (const k of Object.keys(DEFS)) REFS[k] = Joi.ref(`$limits.${k}`);

LIMITS.DEFS = DEFS;
LIMITS.REFS = REFS;
LIMITS.QUANTITY_HARD_MAX = QUANTITY_HARD_MAX;
LIMITS.defaults = () => Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.default]));

module.exports = LIMITS;
