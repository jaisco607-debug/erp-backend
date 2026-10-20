// One dispatch of cloth to a department, with its own Job#. See migration 20261013000008.
const { DataTypes, Model } = require('sequelize');
const { num } = require('./SoCard');

const STATUSES = ['IN_WAY', 'QUEUE', 'PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'];

class Job extends Model {}

function init(sequelize) {
  Job.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      jobNo: { type: DataTypes.INTEGER, allowNull: false },
      jobDate: { type: DataTypes.DATEONLY, allowNull: false },
      departmentId: { type: DataTypes.UUID, allowNull: false },
      fromDepartmentId: { type: DataTypes.UUID, allowNull: true },
      colourId: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'IN_WAY' },
      totalMeters: { ...num('totalMeters'), allowNull: false },
      isReprocess: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      isRework: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      rejectReason: { type: DataTypes.STRING(300), allowNull: true },
      rejectAnswer: { type: DataTypes.STRING(10), allowNull: true },
      rejectAnswerReason: { type: DataTypes.STRING(300), allowNull: true },
      disputedRejectReason: { type: DataTypes.STRING(300), allowNull: true },
      rejectAnswerById: { type: DataTypes.UUID, allowNull: true },
      rejectAnswerAt: { type: DataTypes.DATE, allowNull: true },
      sentThrough: { type: DataTypes.STRING(120), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      instructions: { type: DataTypes.STRING(1000), allowNull: true },
      operatorName: { type: DataTypes.STRING(80), allowNull: true },
      operatorSetById: { type: DataTypes.UUID, allowNull: true },
      operatorSetAt: { type: DataTypes.DATE, allowNull: true },
      processDate: { type: DataTypes.DATEONLY, allowNull: true },
      receivedById: { type: DataTypes.UUID, allowNull: true },
      receivedAt: { type: DataTypes.DATE, allowNull: true },
      acceptedById: { type: DataTypes.UUID, allowNull: true },
      acceptedAt: { type: DataTypes.DATE, allowNull: true },
      statusById: { type: DataTypes.UUID, allowNull: true },
      statusAt: { type: DataTypes.DATE, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Job', tableName: 'jobs' },
  );
  return Job;
}

module.exports = { Job, init, STATUSES };
