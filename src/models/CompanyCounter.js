// The next number of a company-wide sequence (lot numbers, type numbers).
const { DataTypes, Model } = require('sequelize');

class CompanyCounter extends Model {}

function init(sequelize) {
  CompanyCounter.init(
    {
      companyId: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.STRING(40), primaryKey: true },
      nextValue: { type: DataTypes.INTEGER, allowNull: false },
    },
    { sequelize, modelName: 'CompanyCounter', tableName: 'company_counters', timestamps: false },
  );
  return CompanyCounter;
}

module.exports = { CompanyCounter, init };
