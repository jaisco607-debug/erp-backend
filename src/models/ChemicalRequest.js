// Department chemical request and its lines. See migration 20261017000001.
const { DataTypes, Model } = require('sequelize');

const STATUSES = ['PENDING', 'ACCEPTED', 'IN_WAY', 'DELIVERED', 'CANCELLED', 'REJECTED'];
const dec = (field, p, s) => ({
  type: DataTypes.DECIMAL(p, s),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});
const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const uuid = () => ({ type: DataTypes.UUID, allowNull: true });
const at = () => ({ type: DataTypes.DATE, allowNull: true });

class ChemicalRequest extends Model {}
class ChemicalRequestLine extends Model {}

function init(sequelize) {
  ChemicalRequest.init(
    {
      id,
      companyId: { type: DataTypes.UUID, allowNull: false },
      reqNo: { type: DataTypes.INTEGER, allowNull: false },
      departmentId: { type: DataTypes.UUID, allowNull: false },
      jobId: { type: DataTypes.UUID, allowNull: false },
      soCardId: uuid(),
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'PENDING', validate: { isIn: [STATUSES] } },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      rejectReason: { type: DataTypes.STRING(300), allowNull: true },
      sentThrough: { type: DataTypes.STRING(120), allowNull: true },
      totalValue: { ...dec('totalValue', 16, 2), allowNull: false, defaultValue: 0 },
      returnedValue: { ...dec('returnedValue', 16, 2), allowNull: false, defaultValue: 0 },
      requestedById: uuid(), requestedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      acceptedById: uuid(), acceptedAt: at(),
      sentById: uuid(), sentAt: at(),
      receivedById: uuid(), receivedAt: at(),
      closedById: uuid(), closedAt: at(),
    },
    { sequelize, modelName: 'ChemicalRequest', tableName: 'chemical_requests' },
  );
  ChemicalRequestLine.init(
    {
      id,
      requestId: { type: DataTypes.UUID, allowNull: false },
      itemId: { type: DataTypes.UUID, allowNull: false },
      qty: { ...dec('qty', 16, 3), allowNull: false },
      sentQty: { ...dec('sentQty', 16, 3), allowNull: true },
      rate: { ...dec('rate', 16, 4), allowNull: true },
      value: { ...dec('value', 16, 2), allowNull: false, defaultValue: 0 },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      returnedQty: { ...dec('returnedQty', 16, 3), allowNull: false, defaultValue: 0 },
      returnedValue: { ...dec('returnedValue', 16, 2), allowNull: false, defaultValue: 0 },
      // chemical not in stock: alternate offered by the store, or when it will come
      originalItemId: uuid(),
      altItemId: uuid(),
      altQty: { ...dec('altQty', 16, 3), allowNull: true },
      altStatus: { type: DataTypes.STRING(10), allowNull: true },
      altNote: { type: DataTypes.STRING(300), allowNull: true },
      altOfferedById: uuid(), altOfferedAt: at(),
      altDecidedById: uuid(), altDecidedAt: at(),
      etaDate: { type: DataTypes.DATEONLY, allowNull: true },
      etaNote: { type: DataTypes.STRING(300), allowNull: true },
      etaById: uuid(), etaAt: at(),
    },
    { sequelize, modelName: 'ChemicalRequestLine', tableName: 'chemical_request_lines', timestamps: false },
  );
  return { ChemicalRequest, ChemicalRequestLine };
}

module.exports = { STATUSES, init };
