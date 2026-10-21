// An email is unique inside one company (people log in with company code + email). 409 EMAIL_TAKEN otherwise.
const { Op } = require('sequelize');
const { User } = require('../models');
const AppError = require('../utils/AppError');

async function assertEmailFree(companyId, email, exceptId, transaction) {
  const where = { companyId: companyId || null, email: email.trim().toLowerCase() };
  if (exceptId) where.id = { [Op.ne]: exceptId };
  const taken = await User.findOne({ where, attributes: ['id'], transaction });
  if (taken) throw new AppError(409, 'EMAIL_TAKEN', 'This email is already used in this company');
}

module.exports = { assertEmailFree };
