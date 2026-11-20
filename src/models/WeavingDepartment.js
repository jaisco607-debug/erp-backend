// A department of the weaving module (Masters > Department): the beams belong to one. Each company keeps its own list; the name is unique without regard to letter case.
const { DataTypes, Model } = require('sequelize');

class WeavingDepartment extends Model {}

function init(sequelize) {
  WeavingDepartment.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'WeavingDepartment', tableName: 'weaving_departments', paranoid: true },
  );
  return WeavingDepartment;
}

module.exports = { WeavingDepartment, init };
