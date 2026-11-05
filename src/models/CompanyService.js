// Which services a company has been given by the super admin. One row = one service for one company.
const { DataTypes, Model } = require('sequelize');

class CompanyService extends Model {}

function init(sequelize) {
  CompanyService.init(
    {
      companyId: { type: DataTypes.UUID, primaryKey: true },
      serviceId: { type: DataTypes.UUID, primaryKey: true },
      givenById: { type: DataTypes.UUID, allowNull: true },
      // a department the client admin allowed (true) or not (false) to request chemicals from the Chemical Store
      chemicalRequests: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { sequelize, modelName: 'CompanyService', tableName: 'company_services', updatedAt: false },
  );
  return CompanyService;
}

module.exports = { CompanyService, init };
