// A client company. Its admins and users log in with the company code + their email + password.
const { DataTypes, Model } = require('sequelize');
const { normalize } = require('../utils/companyCode');

class Company extends Model {
  toSafeJSON() {
    return {
      id: this.id,
      name: this.name,
      code: this.code,
      contactPerson: this.contactPerson,
      phone: this.phone,
      address: this.address,
      isActive: this.isActive,
      createdAt: this.createdAt,
    };
  }
}

function init(sequelize) {
  Company.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING(150), allowNull: false },
      code: {
        type: DataTypes.STRING(50),
        allowNull: false,
        set(value) {
          this.setDataValue('code', normalize(value));
        },
      },
      contactPerson: { type: DataTypes.STRING(120), allowNull: true },
      phone: { type: DataTypes.STRING(30), allowNull: true },
      address: { type: DataTypes.STRING(300), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // 1 = January ... 12 = December; Pakistan's usual fiscal year starts in July (accounting settings)
      fiscalYearStartMonth: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 7 },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Company', tableName: 'companies', paranoid: true },
  );
  return Company;
}

module.exports = { Company, init };
