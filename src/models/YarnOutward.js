// A yarn outward (one delivery challan) and its lines (see migration 20261205000001).
const { DataTypes, Model } = require('sequelize');

class YarnOutward extends Model {}
class YarnOutwardLine extends Model {}
class YarnOutwardBeam extends Model {}

function init(sequelize) {
  YarnOutward.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING(12), allowNull: false },
      challanNo: { type: DataTypes.INTEGER, allowNull: false },
      outwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      // the party the yarn goes back to (type RETURN only)
      customerId: { type: DataTypes.UUID, allowNull: true },
      vendorId: { type: DataTypes.UUID, allowNull: true },
      department: { type: DataTypes.STRING(50), allowNull: true },
      description: { type: DataTypes.STRING(300), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnOutward', tableName: 'yarn_outwards', paranoid: true },
  );
  YarnOutwardLine.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      outwardId: { type: DataTypes.UUID, allowNull: false },
      inwardId: { type: DataTypes.UUID, allowNull: false },
      bags: { type: DataTypes.INTEGER, allowNull: false },
      lbs: { type: DataTypes.DECIMAL(16, 2), allowNull: false },
      // a SALE line: the selling rate per lb and the amount (lbs x rate)
      ratePerLb: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      amount: { type: DataTypes.DECIMAL(16, 2), allowNull: true },
    },
    { sequelize, modelName: 'YarnOutwardLine', tableName: 'yarn_outward_lines' },
  );
  YarnOutwardBeam.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      outwardId: { type: DataTypes.UUID, allowNull: false },
      beamId: { type: DataTypes.UUID, allowNull: false },
      prevStatus: { type: DataTypes.STRING(10), allowNull: false },
      prevStatusDate: { type: DataTypes.DATEONLY, allowNull: false },
    },
    { sequelize, modelName: 'YarnOutwardBeam', tableName: 'yarn_outward_beams', timestamps: false },
  );
  return { YarnOutward, YarnOutwardLine, YarnOutwardBeam };
}

module.exports = { YarnOutward, YarnOutwardLine, YarnOutwardBeam, init };
