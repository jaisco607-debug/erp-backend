// Everyone who can log in, through one login window:
//   SUPER_ADMIN   runs the platform, gives services to companies (no company)
//   CLIENT_ADMIN  runs one company, gives its users some or all of the company's services
//   USER          works in one company with the services given to them
const { DataTypes, Model } = require('sequelize');

const USER_TYPES = ['SUPER_ADMIN', 'CLIENT_ADMIN', 'USER'];

class User extends Model {
  /** What the API may show about a user. The password hash and lock counters never leave the server. */
  toSafeJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      phone: this.phone,
      userType: this.userType,
      companyId: this.companyId,
      isActive: this.isActive,
      lastLoginAt: this.lastLoginAt,
      createdAt: this.createdAt,
    };
  }

  isLocked() {
    return this.lockedUntil && this.lockedUntil > new Date();
  }
}

function init(sequelize) {
  User.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      name: { type: DataTypes.STRING(120), allowNull: false },
      email: {
        type: DataTypes.STRING(200),
        allowNull: false,
        set(value) {
          this.setDataValue('email', String(value).trim().toLowerCase());
        },
      },
      phone: { type: DataTypes.STRING(30), allowNull: true },
      passwordHash: { type: DataTypes.STRING(100), allowNull: false },
      userType: { type: DataTypes.ENUM(...USER_TYPES), allowNull: false },
      companyId: { type: DataTypes.UUID, allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      failedLoginCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      lockedUntil: { type: DataTypes.DATE, allowNull: true },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true },
      passwordChangedAt: { type: DataTypes.DATE, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'User', tableName: 'users', paranoid: true },
  );
  return User;
}

module.exports = { User, init, USER_TYPES };
