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
const FoldingEntryModel = require('./FoldingEntry');
const StoreModels = require('./Store');
const ChemicalRequestModels = require('./ChemicalRequest');
const ChemicalReturnModels = require('./ChemicalReturn');

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
const { GreyLotThaan, GreyReturn } = GreyLotModel.initThaans(sequelize);
const SoCard = SoCardModel.init(sequelize);
const SoCardLot = SoCardLotModel.init(sequelize);
const SoCardLotThaan = SoCardLotModel.initThaans(sequelize);
const SoCardMove = SoCardMoveModel.init(sequelize);
const Colour = ColourModel.init(sequelize);
const Job = JobModel.init(sequelize);
const JobItem = JobItemModel.init(sequelize);
const FoldingEntry = FoldingEntryModel.init(sequelize);
const storeModels = StoreModels.init(sequelize);
storeModels.StoreMove.belongsTo(Service, { foreignKey: 'departmentId', as: 'department' });
const requestModels = ChemicalRequestModels.init(sequelize);
const returnModels = ChemicalReturnModels.init(sequelize);

// Chemical returns and stock adjustments
{
  const { ChemicalReturn, ChemicalReturnLine, StoreAdjustment, StoreAdjustmentLine } = returnModels;
  ChemicalReturn.hasMany(ChemicalReturnLine, { foreignKey: 'returnId', as: 'lines' });
  ChemicalReturnLine.belongsTo(storeModels.StoreItem, { foreignKey: 'itemId', as: 'item' });
  ChemicalReturn.belongsTo(requestModels.ChemicalRequest, { foreignKey: 'requestId', as: 'request' });
  requestModels.ChemicalRequest.hasMany(ChemicalReturn, { foreignKey: 'requestId', as: 'returns' });
  ChemicalReturn.belongsTo(Service, { foreignKey: 'departmentId', as: 'department' });
  for (const who of ['created', 'received', 'closed']) ChemicalReturn.belongsTo(User, { foreignKey: `${who}ById`, as: `${who}By` });
  StoreAdjustment.hasMany(StoreAdjustmentLine, { foreignKey: 'adjustmentId', as: 'lines' });
  StoreAdjustmentLine.belongsTo(storeModels.StoreItem, { foreignKey: 'itemId', as: 'item' });
  StoreAdjustment.belongsTo(User, { foreignKey: 'createdById', as: 'createdBy' });
}

// Chemical requests
{
  const { ChemicalRequest, ChemicalRequestLine } = requestModels;
  ChemicalRequest.hasMany(ChemicalRequestLine, { foreignKey: 'requestId', as: 'lines' });
  ChemicalRequestLine.belongsTo(ChemicalRequest, { foreignKey: 'requestId', as: 'request' });
  ChemicalRequestLine.belongsTo(storeModels.StoreItem, { foreignKey: 'itemId', as: 'item' });
  ChemicalRequestLine.belongsTo(storeModels.StoreItem, { foreignKey: 'altItemId', as: 'altItem' });
  ChemicalRequestLine.belongsTo(storeModels.StoreItem, { foreignKey: 'originalItemId', as: 'orig' });
  for (const who of ['altOffered', 'altDecided', 'eta']) ChemicalRequestLine.belongsTo(User, { foreignKey: `${who}ById`, as: `${who}By` });
  ChemicalRequest.belongsTo(Service, { foreignKey: 'departmentId', as: 'department' });
  ChemicalRequest.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
  ChemicalRequest.belongsTo(SoCard, { foreignKey: 'soCardId', as: 'soCard' });
  for (const who of ['requested', 'accepted', 'sent', 'received', 'closed']) ChemicalRequest.belongsTo(User, { foreignKey: `${who}ById`, as: `${who}By` });
}

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
GreyLot.hasMany(GreyLotThaan, { foreignKey: 'lotId', as: 'thaans' });
GreyLot.hasMany(GreyReturn, { foreignKey: 'lotId', as: 'returns' });

SoCard.belongsTo(Customer, { foreignKey: 'customerId', as: 'customer' });
SoCard.belongsTo(Quality, { foreignKey: 'qualityId', as: 'quality' });
SoCard.belongsTo(Service, { foreignKey: 'currentDepartmentId', as: 'currentDepartment' });
SoCard.belongsTo(User, { foreignKey: 'createdById', as: 'createdBy' });
SoCard.hasMany(SoCardLot, { foreignKey: 'soCardId', as: 'lots' });
SoCard.hasMany(SoCardMove, { foreignKey: 'soCardId', as: 'moves' });
SoCardLot.belongsTo(GreyLot, { foreignKey: 'greyLotId', as: 'greyLot' });
SoCardLot.hasMany(SoCardLotThaan, { foreignKey: 'soCardLotId', as: 'thaanParts' });
SoCardLotThaan.belongsTo(GreyLotThaan, { foreignKey: 'thaanId', as: 'thaan' });
SoCardMove.belongsTo(Service, { foreignKey: 'fromDepartmentId', as: 'fromDepartment' });
SoCardMove.belongsTo(Service, { foreignKey: 'toDepartmentId', as: 'toDepartment' });

Job.belongsTo(Service, { foreignKey: 'departmentId', as: 'department' });
Job.belongsTo(Service, { foreignKey: 'fromDepartmentId', as: 'fromDepartment' });
Job.belongsTo(Colour, { foreignKey: 'colourId', as: 'colour' });
Job.belongsTo(User, { foreignKey: 'statusById', as: 'statusBy' });
Job.belongsTo(User, { foreignKey: 'receivedById', as: 'receivedBy' });
Job.belongsTo(User, { foreignKey: 'rejectAnswerById', as: 'rejectAnswerBy' });
Job.belongsTo(User, { foreignKey: 'acceptedById', as: 'acceptedBy' });
JobItem.belongsTo(Colour, { foreignKey: 'colourId', as: 'colour' });
JobItem.belongsTo(User, { foreignKey: 'colourSetById', as: 'colourSetBy' });
Job.belongsTo(User, { foreignKey: 'operatorSetById', as: 'operatorSetBy' });
Job.hasMany(JobItem, { foreignKey: 'jobId', as: 'items' });
JobItem.belongsTo(Job, { foreignKey: 'jobId', as: 'job' });
JobItem.belongsTo(SoCard, { foreignKey: 'soCardId', as: 'soCard' });
JobItem.belongsTo(SoCardLot, { foreignKey: 'soCardLotId', as: 'soCardLot' });
SoCardMove.belongsTo(User, { foreignKey: 'sentById', as: 'sentBy' });
SoCardMove.belongsTo(User, { foreignKey: 'acceptedById', as: 'acceptedBy' });

module.exports = {
  ...returnModels,
  RETURN_STATUSES: ChemicalReturnModels.RETURN_STATUSES,
  ADJUST_REASONS: ChemicalReturnModels.ADJUST_REASONS,
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
  GreyLotThaan,
  GreyReturn,
  SoCard,
  SoCardLot,
  SoCardLotThaan,
  SoCardMove,
  Colour,
  Job,
  JobItem,
  FoldingEntry,
  ...storeModels,
  ...requestModels,
  STORES: StoreModels.STORES,
  UNITS: StoreModels.UNITS,
  ACCESS_LEVELS: UserServiceModel.ACCESS_LEVELS,
  USER_TYPES: UserModel.USER_TYPES,
  SERVICE_KINDS: ServiceModel.SERVICE_KINDS,
};
