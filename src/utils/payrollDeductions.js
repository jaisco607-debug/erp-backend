// Income tax is kept on the employee card as a fixed monthly amount (monthlyIncomeTax); EOBI comes from the EOBI module (the employee share of the month's list).
// Exact money: cents as BigInt.
const accountService = require('../services/accountService');

const { toCents, fromCents } = accountService.internals;

/** `percent` of `basic` (an amount) in cents; a missing percent is 0. */
function percentCents(basic, percent) {
  if (percent == null) return 0n;
  const hundredths = BigInt(Math.round(Number(percent) * 100));
  return (toCents(basic) * hundredths + 5000n) / 10000n;
}

/** What the payroll deducts every month for one employee: { incomeTax, eobi, total } as amounts with 2 decimals. `eobiCents` is the employee share on the EOBI list of the month (0 when not listed). */
function monthlyDeductions({ monthlyIncomeTax }, eobiCents = 0n) {
  const tax = toCents(monthlyIncomeTax || 0);
  const eobi = eobiCents == null ? 0n : eobiCents;
  return { incomeTax: fromCents(tax), eobi: fromCents(eobi), total: fromCents(tax + eobi) };
}

module.exports = { percentCents, monthlyDeductions };
