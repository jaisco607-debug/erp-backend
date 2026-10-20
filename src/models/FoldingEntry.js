// Folding grading of one SO card inside one job: A, B and CP (cut piece) meters. See migration 20261014000001.
const { DataTypes, Model } = require('sequelize');
const { num } = require('./SoCard');

class FoldingEntry extends Model {}

function init(sequelize) {
  FoldingEntry.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      jobId: { type: DataTypes.UUID, allowNull: false },
      soCardId: { type: DataTypes.UUID, allowNull: false },
      pageNo: { type: DataTypes.STRING(30), allowNull: true },
      aMeters: { ...num('aMeters'), allowNull: false, defaultValue: 0 },
      bMeters: { ...num('bMeters'), allowNull: false, defaultValue: 0 },
      cpMeters: { ...num('cpMeters'), allowNull: false, defaultValue: 0 },
      isConfirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      confirmedById: { type: DataTypes.UUID, allowNull: true },
      confirmedAt: { type: DataTypes.DATE, allowNull: true },
      isClosed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      closeNote: { type: DataTypes.STRING(300), allowNull: true },
      closedById: { type: DataTypes.UUID, allowNull: true },
      closedAt: { type: DataTypes.DATE, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'FoldingEntry', tableName: 'folding_entries' },
  );
  return FoldingEntry;
}

module.exports = { FoldingEntry, init };
