// One yarn inward entry of the weaving module (see migration 20261203000001).
const { DataTypes, Model } = require('sequelize');

class YarnInward extends Model {}

function init(sequelize) {
  YarnInward.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: true },
      vendorId: { type: DataTypes.UUID, allowNull: true },
      itemId: { type: DataTypes.UUID, allowNull: false },
      // yarn the supplier delivered straight to this sizing party (never came to our factory)
      directVendorId: { type: DataTypes.UUID, allowNull: true },
      bags: { type: DataTypes.INTEGER, allowNull: false },
      lbsPerBag: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      totalLbs: { type: DataTypes.DECIMAL(16, 2), allowNull: false },
      ratePerLb: { type: DataTypes.DECIMAL(14, 4), allowNull: true },
      amount: { type: DataTypes.DECIMAL(16, 2), allowNull: true },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      remarks: { type: DataTypes.STRING(300), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnInward', tableName: 'yarn_inwards', paranoid: true },
  );
  return YarnInward;
}

module.exports = { YarnInward, init };
