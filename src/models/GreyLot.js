// One arrival of grey cloth. Every arrival gets its own lot number, even when the party sent
// one order in parts. Balance = inward meters - outward meters (outward fills in later steps).
const { DataTypes, Model } = require('sequelize');

class GreyLot extends Model {}

// numeric columns come back from Postgres as strings; send numbers to the frontend
const num = (field) => ({
  type: DataTypes.DECIMAL(14, 2),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

function init(sequelize) {
  GreyLot.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      lotNo: { type: DataTypes.INTEGER, allowNull: false },
      typeNo: { type: DataTypes.STRING(20), allowNull: false },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: false },
      qualityId: { type: DataTypes.UUID, allowNull: false },
      inwardMeters: { ...num('inwardMeters'), allowNull: false },
      pieces: { type: DataTypes.INTEGER, allowNull: false },
      outwardMeters: { ...num('outwardMeters'), allowNull: false, defaultValue: 0 },
      unit: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'METER' },
      inwardYards: { ...num('inwardYards'), allowNull: false },
      returnedMeters: { ...num('returnedMeters'), allowNull: false, defaultValue: 0 },
      returnedPieces: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      glm: { ...num('glm'), allowNull: true },
      gsm: { ...num('gsm'), allowNull: true },
      partyRef: { type: DataTypes.STRING(80), allowNull: true },
      vehicleNo: { type: DataTypes.STRING(30), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      isReprocess: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      reprocessOfLotId: { type: DataTypes.UUID, allowNull: true },
      isApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'GreyLot', tableName: 'grey_lots', paranoid: true },
  );
  return GreyLot;
}

// One thaan (piece) of a lot, and one "given back to the party" entry. See migration 20261015000001.
class GreyLotThaan extends Model {}
class GreyReturn extends Model {}

function initThaans(sequelize) {
  GreyLotThaan.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      lotId: { type: DataTypes.UUID, allowNull: false },
      thaanNo: { type: DataTypes.INTEGER, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
      yards: { ...num('yards'), allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'IN_STOCK' },
      returnId: { type: DataTypes.UUID, allowNull: true },
      soCardLotId: { type: DataTypes.UUID, allowNull: true },
      // meters of this thaan already on SO cards (a card can take part of a thaan)
      takenMeters: { ...num('takenMeters'), allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'GreyLotThaan', tableName: 'grey_lot_thaans', timestamps: false },
  );
  GreyReturn.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      lotId: { type: DataTypes.UUID, allowNull: false },
      returnNo: { type: DataTypes.INTEGER, allowNull: false },
      returnDate: { type: DataTypes.DATEONLY, allowNull: false },
      pieces: { type: DataTypes.INTEGER, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
      yards: { ...num('yards'), allowNull: false },
      vehicleNo: { type: DataTypes.STRING(30), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'GreyReturn', tableName: 'grey_returns' },
  );
  return { GreyLotThaan, GreyReturn };
}

module.exports = { GreyLot, GreyLotThaan, GreyReturn, init, initThaans };
