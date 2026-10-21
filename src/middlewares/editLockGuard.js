// Server-side edit-lock enforcement (frontend request, 2026-10-21). Mounted once in front of all routes.
// For every WRITE that edits a record listed below, a live lock held by somebody else (or by another tab of the same
// person, when the browser sends X-Tab-Id) answers 423 LOCKED and nothing is written. No lock = the write goes through.
// A write that touches several records checks every one of them.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const authenticate = require('./authenticate');
const locks = require('../services/lockService');

const ID = '([0-9a-f-]{36})';
const GUID = /^[0-9a-f-]{36}$/i;
const arr = (v) => (Array.isArray(v) ? v : []);
const one = (type, i = 1) => (m) => [{ type, id: m[i] }];
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

const RULES = [
  // jobs
  ['PATCH', new RegExp(`^/v1/jobs/${ID}$`), one('job')],
  ['PUT', new RegExp(`^/v1/jobs/${ID}/(status|operator)$`), one('job')],
  ['PUT', new RegExp(`^/v1/departments/[^/]+/jobs/${ID}/(status|colour|operator)$`), one('job')],
  ['POST', new RegExp(`^/v1/departments/[^/]+/jobs/${ID}/(receive|accept|reject|reject-answer)$`), one('job')],
  // sending cloth on: the jobs the rows come from (department) or the SO cards the rows come from (SO card desk)
  ['POST', /^\/v1\/departments\/[^/]+\/send$/, async (m, req) => {
    const ids = arr(req.body && req.body.items).map((i) => i && i.jobItemId).filter((x) => GUID.test(x || ''));
    if (!ids.length) return [];
    const rows = await q('SELECT DISTINCT ji."jobId" AS id FROM job_items ji JOIN jobs j ON j.id = ji."jobId" WHERE ji.id IN (:ids) AND j."companyId" = :companyId', { ids, companyId: req.user.companyId });
    return rows.map((r) => ({ type: 'job', id: r.id }));
  }],
  ['POST', /^\/v1\/jobs$/, async (m, req) => {
    const ids = arr(req.body && req.body.items).map((i) => i && i.soCardLotId).filter((x) => GUID.test(x || ''));
    if (!ids.length) return [];
    const rows = await q('SELECT DISTINCT l."soCardId" AS id FROM so_card_lots l JOIN so_cards s ON s.id = l."soCardId" WHERE l.id IN (:ids) AND s."companyId" = :companyId', { ids, companyId: req.user.companyId });
    return rows.map((r) => ({ type: 'so_card', id: r.id }));
  }],
  // folding rows (job + SO card)
  ['PUT', new RegExp(`^/v1/departments/[^/]+/folding/${ID}/${ID}(/(grades|close|confirm))?$`), (m) => [{ type: 'folding_row', id: `${m[1]}:${m[2]}` }]],
  ['POST', new RegExp(`^/v1/departments/[^/]+/folding/${ID}/${ID}/send-packing$`), (m) => [{ type: 'folding_row', id: `${m[1]}:${m[2]}` }]],
  // grey lots
  ['PATCH', new RegExp(`^/v1/grey-lots/${ID}$`), one('grey_lot')],
  ['DELETE', new RegExp(`^/v1/grey-lots/${ID}$`), one('grey_lot')],
  ['PUT', new RegExp(`^/v1/grey-lots/${ID}/active$`), one('grey_lot')],
  ['POST', new RegExp(`^/v1/grey-lots/${ID}/(approve|unapprove|give-back)$`), one('grey_lot')],
  ['DELETE', new RegExp(`^/v1/grey-lots/${ID}/give-back/[^/]+$`), one('grey_lot')],
  ['POST', /^\/v1\/grey-lots\/fabric-return$/, (m, req) => arr(req.body && req.body.lots).map((l) => l && l.greyLotId).filter((x) => GUID.test(x || '')).map((id) => ({ type: 'grey_lot', id }))],
  // packing lists (a new list is guarded by its SO card: "so:<soCardId>")
  ['POST', /^\/v1\/departments\/[^/]+\/packing-lists$/, (m, req) => (req.body && GUID.test(req.body.soCardId || '') ? [{ type: 'packing_list', id: `so:${req.body.soCardId}` }] : [])],
  ['PUT', new RegExp(`^/v1/departments/[^/]+/packing-lists/${ID}(/gate-pass)?$`), one('packing_list')],
  ['DELETE', new RegExp(`^/v1/departments/[^/]+/packing-lists/${ID}$`), one('packing_list')],
  ['POST', new RegExp(`^/v1/departments/[^/]+/packing-lists/${ID}/(final|reopen)$`), one('packing_list')],
  // SO cards
  ['PATCH', new RegExp(`^/v1/so-cards/${ID}$`), one('so_card')],
  ['DELETE', new RegExp(`^/v1/so-cards/${ID}$`), one('so_card')],
  ['PUT', new RegExp(`^/v1/so-cards/${ID}/confirm$`), one('so_card')],
  ['POST', new RegExp(`^/v1/so-cards/${ID}/(send|accept)$`), one('so_card')],
  ['POST', /^\/v1\/so-cards\/send-many$/, (m, req) => arr(req.body && req.body.soCardIds).filter((x) => GUID.test(x || '')).map((id) => ({ type: 'so_card', id }))],
  // chemical requests: the store side and the department side
  ['POST', new RegExp(`^/v1/stores/[^/]+/requests/${ID}/(accept|reject|send)$`), one('chemical_request')],
  ['POST', new RegExp(`^/v1/stores/[^/]+/requests/${ID}/lines/[^/]+/(alternate|eta)$`), one('chemical_request')],
  ['PATCH', new RegExp(`^/v1/departments/[^/]+/chemical-requests/${ID}$`), one('chemical_request')],
  ['POST', new RegExp(`^/v1/departments/[^/]+/chemical-requests/${ID}/(cancel|receive)$`), one('chemical_request')],
  ['POST', new RegExp(`^/v1/departments/[^/]+/chemical-requests/${ID}/lines/[^/]+/alternate$`), one('chemical_request')],
  // super admin: a company's services
  ['PUT', new RegExp(`^/v1/companies/${ID}/services(/[^/]+)?$`), one('company_services')],
  // client admin: an employee
  ['PATCH', new RegExp(`^/v1/users/${ID}$`), one('user')],
  ['PUT', new RegExp(`^/v1/users/${ID}/services$`), one('user')],
  ['POST', new RegExp(`^/v1/users/${ID}/reset-password$`), one('user')],
];

async function editLockGuard(req, res, next) {
  try {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    for (const [method, re, resolve] of RULES) {
      if (method !== req.method) continue;
      const m = re.exec(req.path);
      if (!m) continue;
      // sign in first (the route would do it anyway); a bad token is the route's 401
      const authError = await new Promise((done) => { authenticate(req, res, done); });
      if (authError) return next(authError);
      const resources = await resolve(m, req);
      await locks.assertFree(req, resources);
      return next();
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = editLockGuard;
