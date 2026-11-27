// The 4-point system (owner plan N-B1; the way it is used on the inspection table of a textile mill). Pure sums: no database, so they are tested on their own.
//   - each defect gets points by its size: up to 3 inch = 1, 3 to 6 = 2, 6 to 9 = 3, over 9 = 4 (the company may change the points)
//   - some defects have fixed points whatever the size (a hole = 4 in the standard list)
//   - one meter of cloth can never get more than `maxPointsPerMeter` points (4 in the 4-point system; null = no cap)
//   - points per 100 linear meters = points x 100 / meters; per 100 square yards = points x 100 / (length in yards x width in inches / 36)
//   - the grade is the first limit the figure fits in; above the last limit the cloth is REJECT
const YARDS_PER_METER = 1.0936133;

const STANDARD_POINTS = [
  { key: 'S1', label: 'Up to 3 inch', points: 1 },
  { key: 'S2', label: 'Over 3 to 6 inch', points: 2 },
  { key: 'S3', label: 'Over 6 to 9 inch', points: 3 },
  { key: 'S4', label: 'Over 9 inch', points: 4 },
];
// "up to 20 points per 100 = A" is the owner's example; B and C are the usual steps above it
const STANDARD_GRADES = [{ grade: 'A', maxPoints: 20 }, { grade: 'B', maxPoints: 30 }, { grade: 'C', maxPoints: 40 }];
const REJECT = 'REJECT';
const GRADES = ['A', 'B', 'C', REJECT];

const STANDARD_RULES = { pointTable: STANDARD_POINTS, gradeLimits: STANDARD_GRADES, basis: 'METER', maxPointsPerMeter: 4 };

// the usual defects of woven and processed cloth (the client admin loads them once and changes them as he likes)
const STANDARD_DEFECTS = [
  ['HOLE', 'Hole / tear', 4], ['OIL', 'Oil stain'], ['DIRT', 'Dirt stain'], ['SLUB', 'Slub'], ['KNOT', 'Knot'], ['THICK', 'Thick place'], ['THIN', 'Thin place'],
  ['MEND', 'Missing end'], ['MPICK', 'Missing pick'], ['BEND', 'Broken end'], ['REED', 'Reed mark'], ['WBAR', 'Weft bar'], ['FLOAT', 'Float'], ['SELV', 'Selvedge defect'],
  ['SHADE', 'Shade variation'], ['PATCH', 'Dyeing patch'], ['CSTAIN', 'Colour stain'], ['PRINT', 'Print defect'], ['CREASE', 'Crease mark'], ['SKEW', 'Bowing / skewing'],
].map(([code, name, fixedPoints]) => ({ code, name, fixedPoints: fixedPoints || null }));

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/** The points of one defect: the type's fixed points, else the points of its size. Null when the size is not in the table. */
function pointsOf(rules, type, sizeClass) {
  const size = rules.pointTable.find((p) => p.key === sizeClass);
  if (!size) return null;
  return type && type.fixedPoints ? type.fixedPoints : size.points;
}

/** The meter of the cloth a defect sits in (the last meter takes a defect at the very end). */
const meterOf = (atMeter, meters) => Math.min(Math.floor(atMeter), Math.max(0, Math.ceil(meters) - 1));

/** { rawPoints, totalPoints (after the cap per meter) } of a list of defects [{ atMeter, points }]. */
function totalsOf(rules, defects, meters) {
  const rawPoints = defects.reduce((t, d) => t + d.points, 0);
  if (!rules.maxPointsPerMeter) return { rawPoints, totalPoints: rawPoints };
  const perMeter = new Map();
  for (const d of defects) { const m = meterOf(d.atMeter, meters); perMeter.set(m, (perMeter.get(m) || 0) + d.points); }
  return { rawPoints, totalPoints: [...perMeter.values()].reduce((t, x) => t + Math.min(x, rules.maxPointsPerMeter), 0) };
}

/** Points per 100 linear meters, or per 100 square yards (needs the width in inches; null without it). */
function per100(rules, totalPoints, meters, widthInches) {
  if (rules.basis === 'SQ_YARD') {
    if (!widthInches) return null;
    const squareYards = (meters * YARDS_PER_METER * widthInches) / 36;
    return r2((totalPoints * 100) / squareYards);
  }
  return r2((totalPoints * 100) / meters);
}

const gradeOf = (rules, value) => (value === null ? null : ((rules.gradeLimits.find((g) => value <= g.maxPoints) || {}).grade || REJECT));

/** Everything the screen shows for a list of defects. */
function evaluate(rules, defects, meters, widthInches) {
  const { rawPoints, totalPoints } = totalsOf(rules, defects, meters);
  const pointsPer100 = per100(rules, totalPoints, meters, widthInches);
  return { rawPoints, totalPoints, pointsPer100, grade: gradeOf(rules, pointsPer100) };
}

module.exports = { STANDARD_RULES, STANDARD_DEFECTS, GRADES, REJECT, YARDS_PER_METER, pointsOf, totalsOf, per100, gradeOf, evaluate, meterOf };
