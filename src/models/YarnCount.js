// A yarn count of the weaving module, e.g. "22|s", "22|s Cotton". Each company keeps its own list; the name is unique without regard to letter case.
const { DataTypes, Model } = require('sequelize');

class YarnCount extends Model {}

function init(sequelize) {
  YarnCount.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnCount', tableName: 'yarn_counts', paranoid: true },
  );
  return YarnCount;
}

module.exports = { YarnCount, init };
