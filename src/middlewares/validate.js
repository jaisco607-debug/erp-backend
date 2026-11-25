// Checks the shape of incoming data before any controller sees it.
// Unknown fields are refused (nobody can sneak in "userType": "SUPER_ADMIN" on a form that does not offer it).
//
// Two rules that belong to every form, so they are checked here and not in each validator (owner 2026-11-24):
//   - the DATE of a document is at most 5 years from today (back and ahead): a typed 2062 or 1900 is refused with DATE_OUT_OF_RANGE.
//     Only the body is checked (what is saved); the date filters of reports and lists are free.
//   - the METERS of a thaan / job / run / beam have at most 2 decimals: 10.123 is refused, not rounded to 10.12.
const AppError = require('../utils/AppError');
const { businessRange } = require('../utils/dates');

const OPTIONS = { abortEarly: false, allowUnknown: false, convert: true, errors: { wrap: { label: false } } };

// the fields of a body that hold the date of a document
const DATE_KEYS = new Set([
  'date', 'inwardDate', 'returnDate', 'voucherDate', 'chequeDate', 'invoiceDate', 'dueDate', 'cardDate', 'deliveryDate', 'jobDate', 'processDate', 'usageDate', 'issueDate',
  'outwardDate', 'adjDate', 'etaDate', 'batchDate', 'receiptDate', 'startDate', 'endDate', 'beamDate', 'contractDate', 'statusDate', 'applicationDate', 'lastWorkingDay',
  'holidayDate', 'leavingDate', 'advanceDate', 'entryDate', 'clearedDate', 'ratesFrom', 'fromDate', 'toDate', 'passDate', 'effectiveDate',
]);
// an employee may have joined long ago: back 40 years, not more than 5 ahead
const OLD_DATE_KEYS = new Set(['joiningDate']);
const OLD_DATE_YEARS = 40;
// the fields that hold meters (a number, or the list of thaans)
const METER_KEYS = new Set(['meters', 'inMeters', 'outMeters', 'lengthM', 'leftM', 'thaans']);
const METER_DECIMALS = require('../config/limits').meterDecimals;

/** Every date field of the body (also inside lists): the first field outside the allowed days, or null. */
function outOfRange(node, path, range, oldRange) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) { const bad = outOfRange(node[i], `${path}.${i}`, range, oldRange); if (bad) return bad; }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const here = `${path}.${k}`;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && (DATE_KEYS.has(k) || OLD_DATE_KEYS.has(k))) {
        const r = OLD_DATE_KEYS.has(k) ? oldRange : range;
        if (v < r.min || v > r.max) return { field: here, value: v, min: r.min, max: r.max };
      } else if (v && typeof v === 'object') {
        const bad = outOfRange(v, here, range, oldRange);
        if (bad) return bad;
      }
    }
  }
  return null;
}

/** Meters that Joi rounded (10.123 -> 10.12): compares what was sent with what came out. A float like 12.299999999999999 is not a typed decimal. */
function tooManyDecimals(raw, value, path, inMeters, out) {
  if (Array.isArray(raw) && Array.isArray(value)) {
    raw.forEach((r, i) => tooManyDecimals(r, value[i], `${path}.${i}`, inMeters, out));
  } else if (raw && value && typeof raw === 'object' && typeof value === 'object') {
    for (const k of Object.keys(raw)) tooManyDecimals(raw[k], value[k], `${path}.${k}`, inMeters || METER_KEYS.has(k), out);
  } else if (inMeters && (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) && typeof value === 'number') {
    if (Math.abs(Number(raw) - value) > 1e-6) out.push({ field: path, message: `meters can have at most ${METER_DECIMALS} decimals (${raw} is too long)` });
  }
}

/**
 * @param schemas { body, params, query } Joi schemas; any part not given must be empty.
 * The cleaned query goes to req.validatedQuery (Express 5 does not allow replacing req.query).
 */
function validate(schemas) {
  return (req, res, next) => {
    const details = [];
    let dateProblem = null;
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;
      const raw = req[part] ?? {};
      const { value, error } = schema.validate(raw, OPTIONS);
      if (error) {
        details.push(...error.details.map((d) => ({ field: [part, ...d.path].join('.'), message: d.message })));
      } else if (part === 'query') {
        req.validatedQuery = value;
      } else {
        if (part === 'body') {
          tooManyDecimals(raw, value, 'body', false, details);
          dateProblem = outOfRange(value, 'body', businessRange(), businessRange(undefined, OLD_DATE_YEARS));
        }
        req[part] = value;
      }
    }
    if (details.length) return next(AppError.validation(details));
    if (dateProblem) {
      const f = dateProblem.field.replace(/^body\./, '');
      return next(AppError.rule('DATE_OUT_OF_RANGE', `${f}: ${dateProblem.value} is too far from today; use a date between ${dateProblem.min} and ${dateProblem.max}`, { ...dateProblem, field: f }));
    }
    next();
  };
}

module.exports = validate;
