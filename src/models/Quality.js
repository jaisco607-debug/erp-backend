// A cloth quality, e.g. CANVAS 10X7/72X30=65.50". Each company keeps its own list.
const { DataTypes, Model } = require('sequelize');

class Quality extends Model {}

function init(sequelize) {
  Quality.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Quality', tableName: 'qualities', paranoid: true },
  );
  return Quality;
}

module.exports = { Quality, init };
