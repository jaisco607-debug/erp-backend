// Loads every model once and connects them to each other. Other files import models from here.
const { sequelize } = require('../config/database');
const UserModel = require('./User');
const RefreshTokenModel = require('./RefreshToken');
const AuditLogModel = require('./AuditLog');
const CompanyModel = require('./Company');
const ServiceModel = require('./Service');
const CompanyServiceModel = require('./CompanyService');
const PlatformModel = require('./Platform');
const UserServiceModel = require('./UserService');
const CustomerModel = require('./Customer');
const QualityModel = require('./Quality');
const CompanyCounterModel = require('./CompanyCounter');
const GreyLotModel = require('./GreyLot');
const SoCardModel = require('./SoCard');
const SoCardLotModel = require('./SoCardLot');
const SoCardMoveModel = require('./SoCardMove');
const ColourModel = require('./Colour');
const JobModel = require('./Job');
const JobItemModel = require('./JobItem');

const User = UserModel.init(sequelize);
const RefreshToken = RefreshTokenModel.init(sequelize);
const AuditLog = AuditLogModel.init(sequelize);
const Company = CompanyModel.init(sequelize);
const Service = ServiceModel.init(sequelize);
const CompanyService = CompanyServiceModel.init(sequelize);
const Platform = PlatformModel.init(sequelize);
const UserService = UserServiceModel.init(sequelize);
const Customer = CustomerModel.init(sequelize);
const Quality = QualityModel.init(sequelize);
const CompanyCounter = CompanyCounterModel.init(sequelize);
const GreyLot = GreyLotModel.init(sequelize);
const SoCard = SoCardModel.init(sequelize);
const SoCardLot = SoCardLotModel.init(sequelize);
const SoCardMove = SoCardMoveModel.init(sequelize);
const Colour = ColourModel.init(sequelize);
const Job = JobModel.init(sequelize);
const JobItem = JobItemModel.init(sequelize);

// Relations
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'sessions' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

Company.hasMany(User, { foreignKey: 'companyId', as: 'users' });
User.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });

Company.belongsToMany(Service, { through: CompanyService, foreignKey: 'companyId', otherKey: 'serviceId', as: 'services' });
Service.belongsToMany(Company, { through: CompanyService, foreignKey: 'serviceId', otherKey: 'companyId', as: 'companies' });

User.hasMany(UserService, { foreignKey: 'userId', as: 'grants' });
UserService.belongsTo(User, { foreignKey: 'userId', as: 'user' });
UserService.belongsTo(Service, { foreignKey: 'serviceId', as: 'service' });

GreyLot.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
GreyLot.belongsTo(Quality, { foreignKey: 'qualityId', as: 'quality' });
GreyLot.belongsTo(GreyLot, { foreignKey: 'reprocessOfLotId', as: 'reprocessOf' });

SoCard.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
SoCard.belongsTo(Quality, { foreignKey: 'qualityId', as: 'quality' });
SoCard.belongsTo(Service, { foreignKey: 'currentDepartmentId', as: 'currentDepartment' });
SoCard.hasMany(SoCardLot, { foreignKey: 'soCardId', as: 'lots' });
SoCard.hasMany(SoCardMove, { foreignKey: 'soCardId', as: 'moves' });
SoCardLot.belongsTo(GreyLot, { foreignKey: 'greyLotId', as: 'greyLot' });
SoCardMove.belongsTo(Service, { foreignKey: 'fromDepartmentId', as: 'fromDepartment' });
SoCardMove.belongsTo(Service, { foreignKey: 'toDepartmentId', as: 'toDepartment' });

Job.belongsTo(Service, { foreignKey: 'departmentId', as: 'department' });
Job.belongsTo(Service, { foreignKey: 'fromDepartmentId', as: 'fromDepartment' });
Job.belongsTo(Colour, { foreignKey: 'colourId', as: 'colour' });
Job.belongsTo(User, { foreignKey: 'statusById', as: 'statusBy' });
Job.hasMany(JobItem, { foreignKey: 'jobId', as: 'items' });
JobItem.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
JobItem.belongsTo(SoCard, { foreignKey: 'soCardId', as: 'soCard' });
JobItem.belongsTo(SoCardLot, { foreignKey: 'soCardLotId', as: 'soCardLot' });
SoCardMove.belongsTo(User, { foreignKey: 'sentById', as: 'sentBy' });
SoCardMove.belongsTo(User, { foreignKey: 'acceptedById', as: 'acceptedBy' });

module.exports = {
  sequelize,
  User,
  RefreshToken,
  AuditLog,
  Company,
  Service,
  CompanyService,
  Platform,
  UserService,
  Customer,
  Quality,
  CompanyCounter,
  GreyLot,
  SoCard,
  SoCardLot,
  SoCardMove,
  Colour,
  Job,
  JobItem,
  ACCESS_LEVELS: UserServiceModel.ACCESS_LEVELS,
  USER_TYPES: UserModel.USER_TYPES,
  SERVICE_KINDS: ServiceModel.SERVICE_KINDS,
};
