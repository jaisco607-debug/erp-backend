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
      // the lot just before this card took cloth: meters already gone out, and meters left
      outBefore: { ...num('outBefore'), allowNull: true },
      balanceBefore: { ...num('balanceBefore'), allowNull: true },
    },
    { sequelize, modelName: 'SoCardLot', tableName: 'so_card_lots' },
  );
  return SoCardLot;
}

// Which thaan, and how many meters of it, an SO card line took (part of a thaan is allowed).
class SoCardLotThaan extends Model {}

function initThaans(sequelize) {
  SoCardLotThaan.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      soCardLotId: { type: DataTypes.UUID, allowNull: false },
      thaanId: { type: DataTypes.UUID, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
    },
    { sequelize, modelName: 'SoCardLotThaan', tableName: 'so_card_lot_thaans', timestamps: false },
  );
  return SoCardLotThaan;
}

module.exports = { SoCardLot, SoCardLotThaan, init, initThaans };
