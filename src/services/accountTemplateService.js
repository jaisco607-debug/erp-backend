// Business templates of the Chart of Accounts: a ready tree for a Shop, a Service business, a Restaurant, a Manufacturer or "Other".
// Applying one is safe to repeat: accounts whose code exists are skipped, and the result lists what was created and what was skipped.
// It is refused once entries have been posted to the books.
const { sequelize, Account } = require('../models');
const catalog = require('./accountCatalog');
const accountService = require('./accountService');
const AppError = require('../utils/AppError');
const audit = require('./auditService');

const { lockCompany, loadAll, json, normalBalanceOf } = accountService.internals;

const previewOf = (a) => ({
  code: a.code, name: a.name, parentCode: a.parentCode, accountType: a.accountType, isGroup: a.isGroup, subType: a.subType, controlType: a.controlType,
  isContra: a.isContra, isSystem: Boolean(a.systemKey), systemKey: a.systemKey,
});

/** GET /accounts/templates */
function list() {
  return {
    data: catalog.TEMPLATES.map((t) => {
      const accounts = t.accounts().map(previewOf);
      return { key: t.key, label: t.label, description: t.description, accountCount: accounts.length, systemAccounts: accounts.filter((a) => a.isSystem).map((a) => a.systemKey), accounts };
    }),
  };
}

/** POST /accounts/apply-template { templateKey } */
async function apply(req, { templateKey }) {
  const template = catalog.TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw AppError.notFound('Template');
  const { companyId } = req.user;

  return sequelize.transaction(async (transaction) => {
    await lockCompany(companyId, transaction);
    const [lines] = await sequelize.query('SELECT 1 FROM journal_lines WHERE "companyId" = $1 LIMIT 1', { bind: [companyId], transaction });
    if (lines.length) throw AppError.rule('CHART_HAS_ENTRIES', 'Entries have already been posted to the books; a template can no longer be applied');

    const { rows, byId } = await loadAll(companyId, transaction);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const created = [];
    const skipped = [];
    const adopted = [];
    const skip = (a, reason) => skipped.push({ code: a.code, name: a.name, reason });

    for (const a of template.accounts()) {
      const existing = byCode.get(a.code);
      if (existing) { skip(a, 'CODE_EXISTS'); continue; }
      const parent = a.parentCode ? byCode.get(a.parentCode) : null;
      if (a.parentCode && !parent) { skip(a, 'PARENT_MISSING'); continue; }
      if (parent && (!parent.isGroup || parent.accountType !== a.accountType)) { skip(a, 'PARENT_MISMATCH'); continue; }
      if (rows.some((r) => (r.parentId || null) === (parent ? parent.id : null) && r.name.toLowerCase() === a.name.toLowerCase())) { skip(a, 'NAME_EXISTS'); continue; }

      // a system account the company already has (made by hand or by an invoice) stays the system account: no second one
      if (a.systemKey) {
        const holder = rows.find((r) => r.systemKey === a.systemKey);
        if (holder) { skip(a, 'SYSTEM_KEY_EXISTS'); continue; }
        const same = a.controlType && rows.find((r) => r.controlType === a.controlType && !r.systemKey);
        if (same && Object.keys(catalog.SYSTEM_KEY_OF_CONTROL).includes(a.controlType)) {
          const row = await Account.findByPk(same.id, { transaction });
          const before = json(row);
          row.isSystem = true;
          row.systemKey = a.systemKey;
          await row.save({ transaction });
          same.isSystem = true;
          same.systemKey = a.systemKey;
          adopted.push({ code: same.code, name: same.name, systemKey: a.systemKey });
          await audit.log(req, { action: 'ACCOUNT_UPDATED', entityType: 'Account', entityId: row.id, before, after: { ...json(row), madeSystemByTemplate: template.key } }, { transaction });
          continue;
        }
        if (a.controlType && rows.some((r) => r.controlType === a.controlType)) { skip(a, 'CONTROL_TAKEN'); continue; }
      } else if (a.controlType && ['CASH', 'BANK'].indexOf(a.controlType) < 0 && rows.some((r) => r.controlType === a.controlType)) {
        skip(a, 'CONTROL_TAKEN');
        continue;
      }

      const normalBalance = normalBalanceOf(a.accountType, a.isContra);
      const row = await Account.create({
        companyId, code: a.code, name: a.name, parentId: parent ? parent.id : null, isGroup: a.isGroup, accountType: a.accountType, normalBalance,
        subType: a.subType, controlType: a.controlType, isContra: a.isContra, isActive: true, isSystem: Boolean(a.systemKey), systemKey: a.systemKey,
        openingBalance: 0, openingSide: normalBalance, createdById: req.user.id,
      }, { transaction });
      const plain = row.get({ plain: true });
      rows.push(plain);
      byId.set(plain.id, plain);
      byCode.set(plain.code, plain);
      created.push({ code: a.code, name: a.name });
    }
    await audit.log(req, { action: 'CHART_TEMPLATE_APPLIED', entityType: 'Account', after: { templateKey, created: created.length, skipped: skipped.length, adopted: adopted.length } }, { transaction });
    return { templateKey, label: template.label, created, skipped, adopted };
  });
}

module.exports = { list, apply };
