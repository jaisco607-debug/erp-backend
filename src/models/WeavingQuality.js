// A quality of the weaving module (Masters > Quality): picked on the Sizing Batch. Each company keeps its own list; the name is unique without regard to letter case.
const { DataTypes, Model } = require('sequelize');

class WeavingQuality extends Model {}

function init(sequelize) {
  WeavingQuality.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'WeavingQuality', tableName: 'weaving_qualities', paranoid: true },
  );
  return WeavingQuality;
}

module.exports = { WeavingQuality, init };
