// Which services a company has been given by the super admin. One row = one service for one company.
const { DataTypes, Model } = require('sequelize');

class CompanyService extends Model {}

function init(sequelize) {
  CompanyService.init(
    {
      companyId: { type: DataTypes.UUID, primaryKey: true },
      serviceId: { type: DataTypes.UUID, primaryKey: true },
      givenById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'CompanyService', tableName: 'company_services', updatedAt: false },
  );
  return CompanyService;
}

module.exports = { CompanyService, init };
