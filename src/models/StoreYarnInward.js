// Store Management > Yarn Inward: yarn bought from a vendor (typed on the form, no yarn count / item card master). See migration 20261220000001.
const { DataTypes, Model } = require('sequelize');

class StoreYarnInward extends Model {}

const num = (field, scale = 2) => ({
  type: DataTypes.DECIMAL(16, scale),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

function init(sequelize) {
  StoreYarnInward.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      inwardNo: { type: DataTypes.INTEGER, allowNull: false },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      vendorId: { type: DataTypes.UUID, allowNull: false },
      yarnName: { type: DataTypes.STRING(120), allowNull: false },
      brand: { type: DataTypes.STRING(80), allowNull: true },
      bags: { type: DataTypes.INTEGER, allowNull: false },
      lbsPerBag: { ...num('lbsPerBag'), allowNull: false },
      totalLbs: { ...num('totalLbs'), allowNull: false },
      ratePerLb: { ...num('ratePerLb', 4), allowNull: true },
      amount: { ...num('amount'), allowNull: true },
      outwardBags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      remarks: { type: DataTypes.STRING(300), allowNull: true },
      isApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'StoreYarnInward', tableName: 'store_yarn_inwards', paranoid: true },
  );
  return StoreYarnInward;
}

module.exports = { StoreYarnInward, init };
