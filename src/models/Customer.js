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
      legalName: { type: DataTypes.STRING(150), allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: true },
      type: { type: DataTypes.STRING(20), allowNull: true },
      payment: { type: DataTypes.STRING(20), allowNull: true },
      cnic: { type: DataTypes.STRING(20), allowNull: true },
      ntn: { type: DataTypes.STRING(30), allowNull: true },
      gstNo: { type: DataTypes.STRING(30), allowNull: true },
      email: { type: DataTypes.STRING(150), allowNull: true },
      city: { type: DataTypes.STRING(80), allowNull: true },
      province: { type: DataTypes.STRING(80), allowNull: true },
      bankName: { type: DataTypes.STRING(100), allowNull: true },
      bankBranch: { type: DataTypes.STRING(100), allowNull: true },
      accountTitle: { type: DataTypes.STRING(150), allowNull: true },
      accountNo: { type: DataTypes.STRING(50), allowNull: true },
      iban: { type: DataTypes.STRING(40), allowNull: true },
      creditLimit: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
      creditDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Customer', tableName: 'customers', paranoid: true },
  );
  return Customer;
}

module.exports = { Customer, init };
