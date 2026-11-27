// The audit log screen of the client admin (owner plan N-A4): read only, a company sees only its own entries.
// A super admin who opened the company is the company's client admin for the request, so he sees that company only while it is opened.
//   list     GET /audit-logs?from=&to=&userId=&entityType=&action=&entityId=&search=&page=&limit=     (a date range is required; at most 92 days; limit at most 200; newest first)
//   get      GET /audit-logs/:id        what the record was before and after (secrets removed, CNIC shown with its last 4 digits)
//   options  GET /audit-logs/options    the users, record types and actions for the filters
// Entries can never be edited or deleted (the table refuses it), and nothing here writes.
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const { dayStart, dayEnd } = require('../utils/dates');

const MAX_DAYS = 92;
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: 'SELECT' });
const iso = (v) => (v ? new Date(v).toISOString() : null);

// never shown: passwords, tokens, hashes, secrets. A CNIC is shown with its last 4 digits only.
const SECRET_KEY = /pass(word)?|token|secret|hash/i;
const CNIC_KEY = /cnic/i;
function sanitize(node) {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_KEY.test(k)) continue;
      if (CNIC_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) { const s = String(v); out[k] = s.length > 4 ? `${'*'.repeat(s.length - 4)}${s.slice(-4)}` : s; continue; }
      out[k] = sanitize(v);
    }
    return out;
  }
  return node;
}

/** The top-level fields whose value differs between before and after (what the screen marks as changed). */
function changedFields(before, after) {
  const a = before && typeof before === 'object' ? before : {};
  const b = after && typeof after === 'object' ? after : {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

async function list(req, { from, to, userId, entityType, action, entityId, search, page = 1, limit = 50 }) {
  const { companyId } = req.user;
  // a record's own history (entityId) may be asked without a range; every other question needs one
  if (!entityId && (!from || !to)) throw AppError.rule('DATE_RANGE_REQUIRED', 'Choose the days to look at: from and to are required', { fields: ['from', 'to'] });
  if (from && to && to < from) throw AppError.rule('RANGE_INVALID', 'The "to" day is before the "from" day', { field: 'to' });
  if (from && to && daysBetween(from, to) > MAX_DAYS) throw AppError.rule('RANGE_TOO_LONG', `Choose at most ${MAX_DAYS} days at a time`, { maxDays: MAX_DAYS });
  const where = ['"companyId" = :companyId'];
  const rep = { companyId };
  if (from) { where.push('at >= :from'); rep.from = dayStart(from); }
  if (to) { where.push('at <= :to'); rep.to = dayEnd(to); }
  if (userId) { where.push('"actorId" = :userId'); rep.userId = userId; }
  if (entityType) { where.push('"entityType" = :entityType'); rep.entityType = entityType; }
  if (action) { where.push('action = :action'); rep.action = action; }
  if (entityId) { where.push('"entityId" = :entityId'); rep.entityId = entityId; }
  if (search) { where.push('(action ILIKE :like OR "entityType" ILIKE :like OR "entityId" ILIKE :like OR "actorEmail" ILIKE :like)'); rep.like = `%${String(search).trim()}%`; }
  const w = where.join(' AND ');
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM audit_logs WHERE ${w}`, rep);
  const rows = await q(`SELECT id::text AS id, at, "actorId", "actorType", "actorEmail", action, "entityType", "entityId", ip, (before IS NOT NULL OR after IS NOT NULL) AS "hasChanges"
    FROM audit_logs WHERE ${w} ORDER BY at DESC, id DESC LIMIT :limit OFFSET :offset`, { ...rep, limit, offset: (page - 1) * limit });
  return {
    data: rows.map((r) => ({
      id: r.id, at: iso(r.at), user: { id: r.actorId, type: r.actorType, email: r.actorEmail }, action: r.action, entityType: r.entityType, entityId: r.entityId, ip: r.ip, hasChanges: r.hasChanges,
    })),
    page, limit, total: n, maxDays: MAX_DAYS,
    // the address is the one the server sees: the proxy's address until the Cloudflare lock is done
    ipNote: 'The IP is the address the server sees. Behind the proxy it can be the proxy address, not the person.',
  };
}

async function get(req, id) {
  const [r] = await q(`SELECT id::text AS id, at, "actorId", "actorType", "actorEmail", action, "entityType", "entityId", before, after, ip, "userAgent", "requestId"
    FROM audit_logs WHERE id = :id AND "companyId" = :companyId`, { id, companyId: req.user.companyId });
  if (!r) throw AppError.notFound('Audit entry');
  const before = sanitize(r.before);
  const after = sanitize(r.after);
  return {
    id: r.id, at: iso(r.at), user: { id: r.actorId, type: r.actorType, email: r.actorEmail }, action: r.action, entityType: r.entityType, entityId: r.entityId,
    before, after, changedFields: changedFields(before, after), ip: r.ip, userAgent: r.userAgent, requestId: r.requestId,
  };
}

async function options(req) {
  const { companyId } = req.user;
  const users = await q('SELECT id, name, email, "userType" FROM users WHERE "companyId" = :companyId ORDER BY name, email', { companyId });
  // what the log of the last half year holds (the filters offer only things that exist)
  const types = await q(`SELECT DISTINCT "entityType" AS v FROM audit_logs WHERE "companyId" = :companyId AND at >= now() - interval '180 days' AND "entityType" IS NOT NULL ORDER BY 1`, { companyId });
  const actions = await q(`SELECT DISTINCT action AS v FROM audit_logs WHERE "companyId" = :companyId AND at >= now() - interval '180 days' ORDER BY 1`, { companyId });
  return {
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, userType: u.userType })),
    entityTypes: types.map((x) => x.v), actions: actions.map((x) => x.v), maxDays: MAX_DAYS,
  };
}

module.exports = { list, get, options, sanitize, changedFields, MAX_DAYS };
