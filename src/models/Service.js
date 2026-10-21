// A service the platform offers to companies: a screen (Grey Store, Gate Pass) or a department (Dyeing, Folding).
const { DataTypes, Model } = require('sequelize');

const SERVICE_KINDS = ['MODULE', 'PROCESS', 'FOLDING', 'PACKING', 'REPORT'];
// the tab of the client's menu a service belongs to (shown grouped on the super admin screen)
const MENU_GROUPS = ['PRODUCTION', 'PROCESS', 'STORE', 'REPORTS'];

class Service extends Model {}

function init(sequelize) {
  Service.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      code: { type: DataTypes.STRING(40), allowNull: false },
      name: { type: DataTypes.STRING(120), allowNull: false },
      kind: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PROCESS' },
      menuGroup: { type: DataTypes.STRING(12), allowNull: true, validate: { isIn: [MENU_GROUPS] } },
      tracksColour: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { sequelize, modelName: 'Service', tableName: 'services' },
  );
  return Service;
}

module.exports = { Service, init, SERVICE_KINDS, MENU_GROUPS };
