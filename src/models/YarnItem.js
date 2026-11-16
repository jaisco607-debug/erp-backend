// The yarn item card of the weaving module: yarn count + brand + packing + bags. Yarn inward will point at it.
const { DataTypes, Model } = require('sequelize');

const PACKINGS = [8, 12, 24, 40];
const DEFAULT_PACKING = 24;
const BAGS = [50, 100];
const DEFAULT_BAGS = 100;

class YarnItem extends Model {}

function init(sequelize) {
  YarnItem.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      yarnCountId: { type: DataTypes.UUID, allowNull: false },
      brandId: { type: DataTypes.UUID, allowNull: false },
      packing: { type: DataTypes.INTEGER, allowNull: false, defaultValue: DEFAULT_PACKING },
      bags: { type: DataTypes.INTEGER, allowNull: false, defaultValue: DEFAULT_BAGS },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'YarnItem', tableName: 'yarn_items', paranoid: true },
  );
  return YarnItem;
}

module.exports = { YarnItem, init, PACKINGS, DEFAULT_PACKING, BAGS, DEFAULT_BAGS };
