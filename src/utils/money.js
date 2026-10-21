// One rounding for all money, quantities and meters: half a unit always goes UP (away from zero), as on paper.
// Math.round(n * 100) / 100 gets some exact halves wrong (0.29 x 0.5 = 0.145 gave 0.14) because of binary float noise,
// so the number is first cleaned to 12 significant digits and then shifted with exponent notation instead of a multiplication.
function round(n, d = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const clean = Math.abs(v).toPrecision(12);
  // very big or very small numbers print in exponent form ("1.00000000000e+18"): no half unit can hide there
  if (clean.includes('e')) return Math.round(v * 10 ** d) / 10 ** d;
  const r = Number(`${Math.round(Number(`${clean}e${d}`))}e-${d}`);
  return v < 0 ? -r : r;
}

module.exports = { round };
