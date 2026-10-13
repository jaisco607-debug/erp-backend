// The last stop for every error. The user always gets { error: { code, message, details? } }.
// Unexpected errors are logged in full but the user only sees "Something went wrong" + the request id,
// so database or code details never leak out.
const { ValidationError, UniqueConstraintError, ForeignKeyConstraintError, DatabaseError } = require('sequelize');
const AppError = require('../utils/AppError');

/**
 * Says where a broken JSON body goes wrong (position, line, column and which character),
 * without sending any of the body back, because it may hold a password.
 */
function jsonProblem(body) {
  if (typeof body !== 'string') return undefined;
  if (body.trim() === '') return { problem: 'body is empty' };
  let position;
  try {
    JSON.parse(body);
    return { problem: 'body must start with { (an object)', firstCharacter: `U+${body.trim().codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` };
  } catch (e) {
    const m = /position (\d+)/.exec(e.message);
    position = m ? Number(m[1]) : body.length;
  }
  const before = body.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  const ch = body[position];
  let character = ch === undefined ? 'end of body' : `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  if (ch && /[\x21-\x7e]/.test(ch) && ch !== '"') character += ` (${ch})`;
  const hints = { 'U+00A0': 'hidden non-breaking space: type the spaces again', 'U+201C': 'curly quote: use the straight " key', 'U+201D': 'curly quote: use the straight " key', 'U+2018': "curly quote: use the straight ' key", 'U+2019': "curly quote: use the straight ' key", 'U+0027': 'single quote: JSON needs double quotes "' };
  return { line, column, character, hint: hints[character.slice(0, 6)] };
}

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    // The reason goes into the terminal log too (field names and rule messages only, never the values sent).
    req.log.warn({ errorCode: err.code, details: err.details }, err.message);
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    const details = jsonProblem(err.body);
    req.log.warn({ jsonProblem: details, contentType: req.headers['content-type'] }, 'Bad JSON body');
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON', details } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body is too large' } });
  }
  if (err instanceof UniqueConstraintError) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same value already exists' } });
  }
  if (err instanceof ForeignKeyConstraintError) {
    return res.status(409).json({ error: { code: 'IN_USE', message: 'This record is linked to other records' } });
  }
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Validation failed', details: err.errors.map((e) => e.message) } });
  }
  if (err instanceof DatabaseError && err.parent?.code === '23514') {
    return res.status(422).json({ error: { code: 'CONSTRAINT', message: 'The change would break a stock or balance rule' } });
  }

  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: req.id } });
};
