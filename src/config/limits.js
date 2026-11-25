// The usual maximums of the numbers people type (owner 2026-11-24): they catch an extra zero, not a real value.
// One place; the validators use it, and GET /api/v1/limits tells the screens the same numbers (for the max of the inputs).
// Rates (the price per kg / lb / meter) have no maximum of their own: only the size the database can hold.
const LIMITS = {
  qty: 100000, // meters of a thaan / job / machine run / beam, store quantity of a line, bags, weight of a bag or a beam
  unitsPerShift: 100000, // units one loom gives in one shift
  lotNo: 999999, // a typed lot number (and the "next lot number" setting)
  lotNoAhead: 1000, // a typed lot number may be at most this far above the next automatic number
  voucherAmount: 1000000000, // one line of a voucher or a journal entry
  basicSalary: 5000000, // basic salary of an employee, per month
  meterDecimals: 2, // meters have at most 2 decimals: 10.123 is refused, not rounded to 10.12
  dateYears: 5, // a document date is at most this many years from today (back and ahead)
};

module.exports = LIMITS;
