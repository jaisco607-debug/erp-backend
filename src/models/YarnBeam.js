// A beam of the weaving module (see migration 20261209000001).
const { DataTypes, Model } = require('sequelize');

class YarnBeam extends Model {}

function init(sequelize) {
  YarnBeam.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      beamNo: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(80), allowNull: false },
      beamDate: { type: DataTypes.DATEONLY, allowNull: false },
      // where the beam is now (EMPTY, FULL, AT_LOOM, AT_SIZING) and since when
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'EMPTY' },
      statusDate: { type: DataTypes.DATEONLY, allowNull: false },
      // the meters of sized yarn on a FULL beam (from the sizing inward)
      meters: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      // the estimated meters left on a FULL beam that came back half cut from a loom (badge "Half cut")
      halfCutM: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
      // the weight of the beam in kg, and the department it belongs to (Masters > Department); both optional
      weightKg: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      departmentId: { type: DataTypes.UUID, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnBeam', tableName: 'yarn_beams', paranoid: true },
  );
  return YarnBeam;
}

const STATUSES = ['EMPTY', 'FULL', 'AT_LOOM', 'AT_SIZING'];
const STATUS_TEXT = { EMPTY: 'Empty', FULL: 'Full', AT_LOOM: 'At loom', AT_SIZING: 'At sizing' };

module.exports = { YarnBeam, init, STATUSES, STATUS_TEXT };
