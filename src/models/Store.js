// Step 7 store models (Chemical Store and General Items Store). See migration 20261014000002.
// They live in one file because they only make sense together.
const { DataTypes, Model } = require('sequelize');

const STORES = ['CHEMICAL', 'GENERAL'];
const UNITS = ['KG', 'LTR', 'PCS', 'MTR', 'FEET', 'BOX', 'BAG', 'ROLL', 'SET', 'PAIR', 'DOZEN', 'DRUM', 'CAN', 'PKT'];

// numeric columns come from Postgres as text; give them back as numbers
const dec = (field, p, s) => ({
  type: DataTypes.DECIMAL(p, s),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const companyId = { type: DataTypes.UUID, allowNull: false };
const store = { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [STORES] } };
const createdById = { type: DataTypes.UUID, allowNull: true };
const isActive = { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true };

class Vendor extends Model {}
class StoreCategory extends Model {}
class StoreBrand extends Model {}
class StoreItem extends Model {}
class StoreInward extends Model {}
class StoreInwardLine extends Model {}
class StoreMove extends Model {}
class DepartmentChemical extends Model {}

function init(sequelize) {
  Vendor.init(
    {
      id, companyId, isActive, createdById,
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      phone: { type: DataTypes.STRING(30), allowNull: true },
      address: { type: DataTypes.STRING(300), allowNull: true },
    },
    { sequelize, modelName: 'Vendor', tableName: 'vendors' },
  );
  const named = { id, companyId, store, isActive, createdById, name: { type: DataTypes.STRING(100), allowNull: false } };
  StoreCategory.init({ ...named }, { sequelize, modelName: 'StoreCategory', tableName: 'store_categories' });
  StoreBrand.init({ ...named }, { sequelize, modelName: 'StoreBrand', tableName: 'store_brands' });
  StoreItem.init(
    {
      id, companyId, store, isActive, createdById,
      name: { type: DataTypes.STRING(150), allowNull: false },
      unit: { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [UNITS] } },
      categoryId: { type: DataTypes.UUID, allowNull: true },
      brandId: { type: DataTypes.UUID, allowNull: true },
      stockQty: { ...dec('stockQty', 16, 3), allowNull: false, defaultValue: 0 },
      stockValue: { ...dec('stockValue', 16, 2), allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'StoreItem', tableName: 'store_items' },
  );
  StoreInward.init(
    {
      id, companyId, store, createdById,
      idNo: { type: DataTypes.INTEGER, allowNull: false },
      ipNo: { type: DataTypes.INTEGER, allowNull: true },
      inwardDate: { type: DataTypes.DATEONLY, allowNull: false },
      billType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'OTHER' },
      vendorId: { type: DataTypes.UUID, allowNull: true },
      acntNo: { type: DataTypes.STRING(30), allowNull: true },
      dcNo: { type: DataTypes.STRING(50), allowNull: true },
      grnNo: { type: DataTypes.STRING(50), allowNull: true },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      totalQty: { ...dec('totalQty', 16, 3), allowNull: false, defaultValue: 0 },
      amount: { ...dec('amount', 16, 2), allowNull: false, defaultValue: 0 },
      salesTax: { ...dec('salesTax', 16, 2), allowNull: false, defaultValue: 0 },
      gstPercent: { ...dec('gstPercent', 5, 2), allowNull: true },
      isApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      approvedById: { type: DataTypes.UUID, allowNull: true },
      approvedAt: { type: DataTypes.DATE, allowNull: true },
    },
    { sequelize, modelName: 'StoreInward', tableName: 'store_inwards' },
  );
  StoreInwardLine.init(
    {
      id,
      inwardId: { type: DataTypes.UUID, allowNull: false },
      itemId: { type: DataTypes.UUID, allowNull: false },
      qty: { ...dec('qty', 16, 3), allowNull: false },
      rate: { ...dec('rate', 16, 4), allowNull: true },
      amount: { ...dec('amount', 16, 2), allowNull: false, defaultValue: 0 },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'StoreInwardLine', tableName: 'store_inward_lines', timestamps: false },
  );
  StoreMove.init(
    {
      id, companyId, store, createdById,
      itemId: { type: DataTypes.UUID, allowNull: false },
      moveDate: { type: DataTypes.DATEONLY, allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      qty: { ...dec('qty', 16, 3), allowNull: false },
      value: { ...dec('value', 16, 2), allowNull: false },
      inwardId: { type: DataTypes.UUID, allowNull: true },
      departmentId: { type: DataTypes.UUID, allowNull: true },
      requestId: { type: DataTypes.UUID, allowNull: true },
      returnId: { type: DataTypes.UUID, allowNull: true },
      adjustmentId: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'StoreMove', tableName: 'store_moves' },
  );

  DepartmentChemical.init(
    {
      id, companyId, createdById,
      departmentId: { type: DataTypes.UUID, allowNull: false },
      itemId: { type: DataTypes.UUID, allowNull: false },
    },
    { sequelize, modelName: 'DepartmentChemical', tableName: 'department_chemicals', updatedAt: false },
  );
  DepartmentChemical.belongsTo(StoreItem, { foreignKey: 'itemId', as: 'item' });

  StoreItem.belongsTo(StoreCategory, { foreignKey: 'categoryId', as: 'category' });
  StoreItem.belongsTo(StoreBrand, { foreignKey: 'brandId', as: 'brand' });
  StoreInward.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'vendor' });
  StoreInward.hasMany(StoreInwardLine, { foreignKey: 'inwardId', as: 'lines' });
  StoreInwardLine.belongsTo(StoreItem, { foreignKey: 'itemId', as: 'item' });
  StoreInwardLine.belongsTo(StoreInward, { foreignKey: 'inwardId', as: 'inward' });
  StoreMove.belongsTo(StoreItem, { foreignKey: 'itemId', as: 'item' });
  StoreMove.belongsTo(StoreInward, { foreignKey: 'inwardId', as: 'inward' });
  return { Vendor, StoreCategory, StoreBrand, StoreItem, StoreInward, StoreInwardLine, StoreMove, DepartmentChemical };
}

module.exports = { STORES, UNITS, init };
