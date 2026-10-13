// One login session (one device / browser). The token itself is never stored, only its SHA-256 hash.
// Every refresh replaces the token with a new one; using an old one again means it was stolen.
const { DataTypes, Model } = require('sequelize');

class RefreshToken extends Model {}

function init(sequelize) {
  RefreshToken.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      userId: { type: DataTypes.UUID, allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      revokedAt: { type: DataTypes.DATE, allowNull: true },
      replacedById: { type: DataTypes.UUID, allowNull: true },
      ip: { type: DataTypes.STRING(64), allowNull: true },
      userAgent: { type: DataTypes.STRING(300), allowNull: true },
    },
    { sequelize, modelName: 'RefreshToken', tableName: 'refresh_tokens', updatedAt: false },
  );
  return RefreshToken;
}

module.exports = { RefreshToken, init };
