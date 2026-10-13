// Settings of the whole platform, one row only (id = 1). For now: the login code shared by all super admins.
const { DataTypes, Model } = require('sequelize');
const { normalize } = require('../utils/companyCode');

class Platform extends Model {}

function init(sequelize) {
  Platform.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
      superAdminCode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        set(value) {
          this.setDataValue('superAdminCode', normalize(value));
        },
      },
    },
    { sequelize, modelName: 'Platform', tableName: 'platform', createdAt: false },
  );
  return Platform;
}

module.exports = { Platform, init };
