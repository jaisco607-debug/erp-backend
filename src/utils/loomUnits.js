// The loom counter gives UNITS. 1 unit = 1,000 picks (weft threads). The cloth made (metres) follows from the picks per inch of the loom (Loom Pick of the K-ID):
//   metres = units x 1000 / (picks per inch x 39.3701 inches per metre)      e.g. 1,114 units at 56 picks = 505.3 m
const INCHES_PER_METRE = 39.3701;
const PICKS_PER_UNIT = 1000;
const n2 = (v) => Math.round(Number(v) * 100) / 100;

/** metres of cloth for a number of units at `pick` picks per inch (null when the pick is not known). */
const unitsToMeters = (units, pick) => (units == null || !Number(pick) ? null : n2((Number(units) * PICKS_PER_UNIT) / (Number(pick) * INCHES_PER_METRE)));

module.exports = { INCHES_PER_METRE, PICKS_PER_UNIT, unitsToMeters };
