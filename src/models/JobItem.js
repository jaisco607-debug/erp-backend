// One SO card's share of a job (which card, which of its grey lots, how many meters).
const { DataTypes, Model } = require('sequelize');
const { num } = require('./SoCard');

class JobItem extends Model {}

function init(sequelize) {
  JobItem.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      jobId: { type: DataTypes.UUID, allowNull: false },
      soCardId: { type: DataTypes.UUID, allowNull: false },
      soCardLotId: { type: DataTypes.UUID, allowNull: false },
      sourceJobItemId: { type: DataTypes.UUID, allowNull: true },
      meters: { ...num('meters'), allowNull: false },
    },
    { sequelize, modelName: 'JobItem', tableName: 'job_items' },
  );
  return JobItem;
}

module.exports = { JobItem, init };
