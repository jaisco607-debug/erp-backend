// One dispatch of cloth to a department, with its own Job#. See migration 20261013000008.
const { DataTypes, Model } = require('sequelize');
const { num } = require('./SoCard');

const STATUSES = ['PENDING', 'PROCESSING', 'COMPLETE', 'REJECTED'];

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
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'PENDING' },
      totalMeters: { ...num('totalMeters'), allowNull: false },
      isReprocess: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      sentThrough: { type: DataTypes.STRING(120), allowNull: true },
      remarks: { type: DataTypes.STRING(500), allowNull: true },
      statusById: { type: DataTypes.UUID, allowNull: true },
      statusAt: { type: DataTypes.DATE, allowNull: true },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Job', tableName: 'jobs' },
  );
  return Job;
}

module.exports = { Job, init, STATUSES };
