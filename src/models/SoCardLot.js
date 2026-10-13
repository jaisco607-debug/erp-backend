// One grey lot's share of an SO card: how many meters (and pieces) were taken from that lot.
const { DataTypes, Model } = require('sequelize');
const { num } = require('./SoCard');

class SoCardLot extends Model {}

function init(sequelize) {
  SoCardLot.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      soCardId: { type: DataTypes.UUID, allowNull: false },
      greyLotId: { type: DataTypes.UUID, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
      pieces: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'SoCardLot', tableName: 'so_card_lots' },
  );
  return SoCardLot;
}

module.exports = { SoCardLot, init };
