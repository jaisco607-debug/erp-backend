// A yarn brand of the weaving module. Each company keeps its own list; the name is unique without regard to letter case.
const { DataTypes, Model } = require('sequelize');

class YarnBrand extends Model {}

function init(sequelize) {
  YarnBrand.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnBrand', tableName: 'yarn_brands', paranoid: true },
  );
  return YarnBrand;
}

module.exports = { YarnBrand, init };
