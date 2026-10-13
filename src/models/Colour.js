// A colour (BLACK, C BLUE ...). Each company keeps its own list; departments pick from it.
const { DataTypes, Model } = require('sequelize');

class Colour extends Model {}

function init(sequelize) {
  Colour.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Colour', tableName: 'colours', paranoid: true },
  );
  return Colour;
}

module.exports = { Colour, init };
