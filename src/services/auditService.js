// Writes audit log rows. Call it inside the same transaction as the change itself:
// if the change is saved, its audit row is saved; if one fails, both are rolled back.
const { AuditLog } = require('../models');

// Never copied into the audit log, wherever they appear in a record.
const SECRET_FIELDS = new Set(['password', 'passwordHash', 'newPassword', 'currentPassword', 'tokenHash', 'refreshToken', 'accessToken']);

function clean(value) {
  if (value === null || value === undefined) return null;
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
  return JSON.parse(
    JSON.stringify(plain, (key, v) => (SECRET_FIELDS.has(key) ? undefined : v)),
  );
}

/**
 * @param req     the request (for who, IP, browser and request id); may be null for system jobs
 * @param entry   { action, entityType, entityId, companyId, before, after, actor }
 *                actor overrides req.user, e.g. on login when nobody is signed in yet
 * @param options { transaction }
 */
async function log(req, entry, options = {}) {
  const actor = entry.actor !== undefined ? entry.actor : req?.user;
  await AuditLog.create(
    {
      actorId: actor?.id ?? null,
      actorType: actor?.userType ?? (actor ? null : 'SYSTEM'),
      actorEmail: actor?.email ?? entry.actorEmail ?? null,
      companyId: entry.companyId !== undefined ? entry.companyId : actor?.companyId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId != null ? String(entry.entityId) : null,
      before: clean(entry.before),
      after: clean(entry.after),
      ip: req?.ip ?? null,
      userAgent: req?.headers?.['user-agent']?.slice(0, 300) ?? null,
      requestId: req?.id ? String(req.id) : null,
    },
    { transaction: options.transaction },
  );
}

module.exports = { log };
