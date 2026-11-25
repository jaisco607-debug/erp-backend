// Small helpers shared by the tests.
const request = require('supertest');
const app = require('../src/app');
const { sequelize, User, Company } = require('../src/models');
const { hashPassword } = require('../src/utils/password');

const PASSWORD = 'Strong-Pass-123';

async function clean() {
  // audit_logs refuses DELETE on purpose; TRUNCATE is blocked too, so tests disable the trigger briefly.
  await sequelize.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_truncate');
  await sequelize.query('TRUNCATE audit_logs, grey_lot_thaans, grey_returns, store_moves, store_inward_lines, store_inwards, store_items, store_brands, store_categories, vendors, folding_entries, job_items, jobs, colours, so_card_moves, so_card_lots, so_cards, grey_lots, company_counters, customers, qualities, refresh_tokens, users, company_services, companies RESTART IDENTITY CASCADE');
  await sequelize.query("DELETE FROM services WHERE code LIKE 'TEST%' OR \"companyId\" IS NOT NULL");
  await sequelize.query('UPDATE services SET "isActive" = true');
  await sequelize.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_truncate');
}

const { generate: generateCode } = require('../src/utils/companyCode');
const { superAdminCode } = require('../src/services/loginCodeService');
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeCompany(fields = {}) {
  return Company.create({ name: 'Test Company', code: generateCode(), ...fields });
}

/** A super admin by default; client admins and users get a new company unless one is given. */
async function makeUser(fields = {}) {
  if (fields.userType && fields.userType !== 'SUPER_ADMIN' && !fields.companyId) {
    fields = { ...fields, companyId: (await makeCompany()).id };
  }
  return User.create({
    name: 'Test User',
    email: `user${rand()}@test.com`,
    passwordHash: await hashPassword(PASSWORD),
    userType: 'SUPER_ADMIN',
    ...fields,
  });
}

const companyCodeOf = async (user) => (user.companyId ? (await Company.findByPk(user.companyId)).code : superAdminCode());

async function loginAs(user, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ companyCode: await companyCodeOf(user), email: user.email, password });
  return res.body;
}

/**
 * Fires the same call twice at the same moment (a double click, or two users) and returns both answers.
 * A reversal (cancel, undo, un-approve, delete) must succeed once: use expectOneSuccess on the answers.
 */
const raceTwice = (fn) => Promise.all([fn(), fn()]);
const expectOneSuccess = (answers) => {
  const good = answers.filter((r) => r.status < 300);
  if (good.length !== 1) throw new Error(`expected exactly one success, got ${good.length}: ${answers.map((r) => r.status + ' ' + (r.body && r.body.error && r.body.error.code)).join(', ')}`);
  return { good: good[0], bad: answers.find((r) => r.status >= 300) };
};

module.exports = { app, request, sequelize, clean, makeUser, makeCompany, loginAs, companyCodeOf, PASSWORD, raceTwice, expectOneSuccess };
