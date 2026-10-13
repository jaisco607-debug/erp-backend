// A service a client admin gave to one of the company's users, with VIEW or FULL access.
const { DataTypes, Model } = require('sequelize');

const ACCESS_LEVELS = ['VIEW', 'FULL'];

class UserService extends Model {}

function init(sequelize) {
  UserService.init(
    {
      userId: { type: DataTypes.UUID, primaryKey: true },
      serviceId: { type: DataTypes.UUID, primaryKey: true },
      access: { type: DataTypes.STRING(10), allowNull: false, validate: { isIn: [ACCESS_LEVELS] } },
      givenById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'UserService', tableName: 'user_services' },
  );
  return UserService;
}

module.exports = { UserService, init, ACCESS_LEVELS };
