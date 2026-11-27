// Store Management > Fabric Inward: cloth bought from a vendor (the grey inward form with a vendor instead of the customer). See migration 20261215000001.
const { DataTypes, Model } = require('sequelize');

class FabricInward extends Model {}
class FabricInwardThaan extends Model {}
class FabricIssue extends Model {}

const num = (field) => ({
  type: DataTypes.DECIMAL(14, 2),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

function init(sequelize) {
  FabricInward.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      inwardNo: { type: DataTypes.INTEGER, allowNull: false },
      typeNo: { type: DataTypes.STRING(20), allowNull: false },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      vendorId: { type: DataTypes.UUID, allowNull: false },
      qualityId: { type: DataTypes.UUID, allowNull: false },
      unit: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'METER' },
      inwardMeters: { ...num('inwardMeters'), allowNull: false },
      inwardYards: { ...num('inwardYards'), allowNull: false },
      pieces: { type: DataTypes.INTEGER, allowNull: false },
      outwardMeters: { ...num('outwardMeters'), allowNull: false, defaultValue: 0 },
      glm: { ...num('glm'), allowNull: true },
      gsm: { ...num('gsm'), allowNull: true },
      width: { ...num('width'), allowNull: true },
      // the rate the cloth was bought at: per METER or per YARD; amount = the sum of the thaan amounts (empty until a rate is given)
      rateUnit: { type: DataTypes.STRING(5), allowNull: true },
      poLineId: { type: DataTypes.UUID, allowNull: true },
      poRateNote: { type: DataTypes.STRING(300), allowNull: true },
      rate: { type: DataTypes.DECIMAL(14, 4), allowNull: true, get() { const v = this.getDataValue('rate'); return v === null || v === undefined ? v : Number(v); } },
      amount: { ...num('amount'), allowNull: true },
      partyRef: { type: DataTypes.STRING(80), allowNull: true },
      vehicleNo: { type: DataTypes.STRING(30), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      isApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'FabricInward', tableName: 'fabric_inwards', paranoid: true },
  );
  FabricInwardThaan.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      inwardId: { type: DataTypes.UUID, allowNull: false },
      thaanNo: { type: DataTypes.INTEGER, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
      yards: { ...num('yards'), allowNull: false },
      width: { ...num('width'), allowNull: true },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'IN_STOCK' },
      takenMeters: { ...num('takenMeters'), allowNull: false, defaultValue: 0 },
      amount: { ...num('amount'), allowNull: true },
      issueId: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'FabricInwardThaan', tableName: 'fabric_inward_thaans', timestamps: false },
  );
  FabricIssue.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      issueNo: { type: DataTypes.INTEGER, allowNull: false },
      issueDate: { type: DataTypes.DATEONLY, allowNull: false },
      fabricInwardId: { type: DataTypes.UUID, allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: false },
      linkedSoCardId: { type: DataTypes.UUID, allowNull: true },
      greyLotId: { type: DataTypes.UUID, allowNull: false },
      meters: { ...num('meters'), allowNull: false },
      pieces: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      remarks: { type: DataTypes.STRING(300), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
      cancelledAt: { type: DataTypes.DATE, allowNull: true },
      cancelledById: { type: DataTypes.UUID, allowNull: true },
      // how it ended: CANCELLED (undone) or RETURNED (the SO card was cancelled and the cloth went back to the store); empty = still issued
      endKind: { type: DataTypes.STRING(10), allowNull: true },
      // the thaan numbers of the entry this issue holds (kept after a return so the edit form can tick them again)
      thaanNos: { type: DataTypes.ARRAY(DataTypes.INTEGER), allowNull: true },
    },
    { sequelize, modelName: 'FabricIssue', tableName: 'fabric_issues' },
  );
  return { FabricInward, FabricInwardThaan, FabricIssue };
}

module.exports = { FabricInward, FabricInwardThaan, FabricIssue, init };
