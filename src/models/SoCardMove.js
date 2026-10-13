// One trip of an SO card to a department: where it went, through whom, and when it was accepted there.
const { DataTypes, Model } = require('sequelize');

class SoCardMove extends Model {}

function init(sequelize) {
  SoCardMove.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      soCardId: { type: DataTypes.UUID, allowNull: false },
      fromDepartmentId: { type: DataTypes.UUID, allowNull: true },
      toDepartmentId: { type: DataTypes.UUID, allowNull: false },
      sentThrough: { type: DataTypes.STRING(120), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      sentById: { type: DataTypes.UUID, allowNull: true },
      sentAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      acceptedById: { type: DataTypes.UUID, allowNull: true },
      acceptedAt: { type: DataTypes.DATE, allowNull: true },
    },
    { sequelize, modelName: 'SoCardMove', tableName: 'so_card_moves' },
  );
  return SoCardMove;
}

module.exports = { SoCardMove, init };
