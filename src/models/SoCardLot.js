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
      // the sub-category (group) of the card this line belongs to; empty = a card made without groups
      groupId: { type: DataTypes.UUID, allowNull: true },
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

// A sub-category of an SO card: a part of its cloth with its own colour tag (see migration 20261129000001).
class SoCardGroup extends Model {}

function initGroups(sequelize) {
  SoCardGroup.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      soCardId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.STRING(3), allowNull: false },
      label: { type: DataTypes.STRING(80), allowNull: true },
      colourId: { type: DataTypes.UUID, allowNull: true },
      remarks: { type: DataTypes.STRING(300), allowNull: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'SoCardGroup', tableName: 'so_card_groups' },
  );
  return SoCardGroup;
}

module.exports = { SoCardLot, SoCardLotThaan, SoCardGroup, init, initThaans, initGroups };
