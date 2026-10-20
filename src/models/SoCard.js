// SO card (travel card): cloth taken out of grey for processing, from one or more lots of one party.
// status: NEW (made, not sent yet) -> SENT (on its way to a department) -> IN_DEPARTMENT (accepted there)
const { DataTypes, Model } = require('sequelize');

const STATUSES = ['NEW', 'SENT', 'IN_DEPARTMENT'];

class SoCard extends Model {}

const num = (field) => ({
  type: DataTypes.DECIMAL(14, 2),
  get() {
    const v = this.getDataValue(field);
    return v === null || v === undefined ? v : Number(v);
  },
});

function init(sequelize) {
  SoCard.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      cardNo: { type: DataTypes.INTEGER, allowNull: false },
      idNo: { type: DataTypes.INTEGER, allowNull: false },
      cardDate: { type: DataTypes.DATEONLY, allowNull: false },
      qualityId: { type: DataTypes.UUID, allowNull: true },
      description: { type: DataTypes.STRING(500), allowNull: true },
      isConfirmed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      confirmedById: { type: DataTypes.UUID, allowNull: true },
      confirmedAt: { type: DataTypes.DATE, allowNull: true },
      customerId: { type: DataTypes.UUID, allowNull: false },
      totalMeters: { ...num('totalMeters'), allowNull: false },
      totalPieces: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isReprocess: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // fabric return grey: unprocessed cloth going back to the party through Folding and Packing
      isGreyReturn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'NEW', validate: { isIn: [STATUSES] } },
      currentDepartmentId: { type: DataTypes.UUID, allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      deliveryDate: { type: DataTypes.DATEONLY, allowNull: true },
      article: { type: DataTypes.STRING(150), allowNull: true },
      instructions: { type: DataTypes.STRING(1000), allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'SoCard', tableName: 'so_cards', paranoid: true },
  );
  return SoCard;
}

module.exports = { SoCard, init, STATUSES, num };
