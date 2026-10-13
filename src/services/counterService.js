// Company-wide running numbers (lot no, type no). The counter row is locked inside the caller's
// transaction, so two people saving at the same moment never get the same number.
const { CompanyCounter } = require('../models');

/**
 * Takes the next number of a sequence and moves the counter on.
 * @param start  async () => first number to use when the company has no counter yet
 */
async function take(companyId, name, start, transaction) {
  let counter = await CompanyCounter.findOne({ where: { companyId, name }, lock: transaction.LOCK.UPDATE, transaction });
  if (!counter) {
    await CompanyCounter.findOrCreate({ where: { companyId, name }, defaults: { nextValue: await start() }, transaction });
    counter = await CompanyCounter.findOne({ where: { companyId, name }, lock: transaction.LOCK.UPDATE, transaction });
  }
  const value = counter.nextValue;
  counter.nextValue = value + 1;
  await counter.save({ transaction });
  return value;
}

async function peek(companyId, name, start, transaction) {
  const counter = await CompanyCounter.findOne({ where: { companyId, name }, transaction });
  return counter ? counter.nextValue : start();
}

async function set(companyId, name, nextValue, transaction) {
  await CompanyCounter.upsert({ companyId, name, nextValue }, { transaction });
}

module.exports = { take, peek, set };
