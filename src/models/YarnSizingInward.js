// A receipt of sized beams from the sizing party (see migration 20261212000001) and the beams on it.
const { DataTypes, Model } = require('sequelize');

class YarnSizingInward extends Model {}
class YarnSizingInwardBeam extends Model {}

function init(sequelize) {
  YarnSizingInward.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      inwardNo: { type: DataTypes.INTEGER, allowNull: false },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      outwardId: { type: DataTypes.UUID, allowNull: false },
      vendorId: { type: DataTypes.UUID, allowNull: false },
      lbsUsed: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
      cutConeKg: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      cutConeLbs: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      ratePerLb: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
      amount: { type: DataTypes.DECIMAL(16, 2), allowNull: false },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      description: { type: DataTypes.STRING(300), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnSizingInward', tableName: 'yarn_sizing_inwards', paranoid: true },
  );
  YarnSizingInwardBeam.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      inwardId: { type: DataTypes.UUID, allowNull: false },
      beamId: { type: DataTypes.UUID, allowNull: false },
      meters: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      prevStatusDate: { type: DataTypes.DATEONLY, allowNull: false },
    },
    { sequelize, modelName: 'YarnSizingInwardBeam', tableName: 'yarn_sizing_inward_beams', timestamps: false },
  );
  return { YarnSizingInward, YarnSizingInwardBeam };
}

module.exports = { YarnSizingInward, YarnSizingInwardBeam, init };
