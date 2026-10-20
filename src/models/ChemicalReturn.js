// Chemical returns and store stock adjustments. See migration 20261017000003.
const { DataTypes, Model } = require('sequelize');

const dec = (field, p, s) => ({
  type: DataTypes.DECIMAL(p, s),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});
const id = () => ({ type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 });
const uuid = (allowNull = true) => ({ type: DataTypes.UUID, allowNull });
const at = () => ({ type: DataTypes.DATE, allowNull: true });
const RETURN_STATUSES = ['PENDING', 'RECEIVED', 'REJECTED', 'CANCELLED'];
const ADJUST_REASONS = ['COUNT', 'DAMAGED', 'EXPIRED', 'LOST', 'OTHER'];

class ChemicalReturn extends Model {}
class ChemicalReturnLine extends Model {}
class StoreAdjustment extends Model {}
class StoreAdjustmentLine extends Model {}

function init(sequelize) {
  ChemicalReturn.init({
    id: id(),
    companyId: uuid(false),
    returnNo: { type: DataTypes.INTEGER, allowNull: false },
    requestId: uuid(false),
    departmentId: uuid(false),
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING', validate: { isIn: [RETURN_STATUSES] } },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    rejectReason: { type: DataTypes.STRING(300), allowNull: true },
    totalValue: { ...dec('totalValue', 16, 2), allowNull: false, defaultValue: 0 },
    createdById: uuid(),
    receivedById: uuid(), receivedAt: at(),
    closedById: uuid(), closedAt: at(),
  }, { sequelize, modelName: 'ChemicalReturn', tableName: 'chemical_returns' });
  ChemicalReturnLine.init({
    id: id(),
    returnId: uuid(false),
    requestLineId: uuid(false),
    itemId: uuid(false),
    qty: { ...dec('qty', 16, 3), allowNull: false },
    rate: { ...dec('rate', 16, 4), allowNull: false, defaultValue: 0 },
    value: { ...dec('value', 16, 2), allowNull: false, defaultValue: 0 },
  }, { sequelize, modelName: 'ChemicalReturnLine', tableName: 'chemical_return_lines', timestamps: false });
  StoreAdjustment.init({
    id: id(),
    companyId: uuid(false),
    store: { type: DataTypes.STRING(10), allowNull: false },
    adjNo: { type: DataTypes.INTEGER, allowNull: false },
    adjDate: { type: DataTypes.DATEONLY, allowNull: false },
    reason: { type: DataTypes.STRING(12), allowNull: false, validate: { isIn: [ADJUST_REASONS] } },
    notes: { type: DataTypes.STRING(500), allowNull: true },
    totalValue: { ...dec('totalValue', 16, 2), allowNull: false, defaultValue: 0 },
    createdById: uuid(),
  }, { sequelize, modelName: 'StoreAdjustment', tableName: 'store_adjustments' });
  StoreAdjustmentLine.init({
    id: id(),
    adjustmentId: uuid(false),
    itemId: uuid(false),
    stockBefore: { ...dec('stockBefore', 16, 3), allowNull: false },
    qty: { ...dec('qty', 16, 3), allowNull: false },
    rate: { ...dec('rate', 16, 4), allowNull: false, defaultValue: 0 },
    value: { ...dec('value', 16, 2), allowNull: false, defaultValue: 0 },
  }, { sequelize, modelName: 'StoreAdjustmentLine', tableName: 'store_adjustment_lines', timestamps: false });
  return { ChemicalReturn, ChemicalReturnLine, StoreAdjustment, StoreAdjustmentLine };
}

module.exports = { RETURN_STATUSES, ADJUST_REASONS, init };
