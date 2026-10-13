// A party that sends cloth to the company. Numbered per company: AZ TEXTILES (130).
const { DataTypes, Model } = require('sequelize');

class Customer extends Model {}

function init(sequelize) {
  Customer.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      phone: { type: DataTypes.STRING(30), allowNull: true },
      address: { type: DataTypes.STRING(300), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Customer', tableName: 'customers', paranoid: true },
  );
  return Customer;
}

module.exports = { Customer, init };
