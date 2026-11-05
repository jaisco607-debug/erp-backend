// One account of a company's Chart of Accounts. Group accounts are headers (they only hold other accounts);
// posting accounts are the ones entries will be posted to (by the accounting engine, a later step).
const { DataTypes, Model } = require('sequelize');

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
// Asset and expense accounts grow on the debit side, the others on the credit side.
const NORMAL_BALANCE = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', INCOME: 'CREDIT' };
// Optional detail inside a type (for the Balance Sheet and Profit & Loss later).
const SUB_TYPES = {
  ASSET: ['CURRENT_ASSET', 'FIXED_ASSET', 'OTHER_ASSET'],
  LIABILITY: ['CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  EQUITY: ['CAPITAL', 'RETAINED_EARNINGS', 'RESERVES', 'DRAWINGS'],
  INCOME: ['OPERATING_REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OPERATING_EXPENSE', 'FINANCE_COST', 'TAX_EXPENSE', 'OTHER_EXPENSE'],
};
// Accounts the accounting engine will look for. `single`: a company has only one of them (cash and bank may be many).
const CONTROL_TYPES = {
  CUSTOMERS: { accountType: 'ASSET', single: true },
  SUPPLIERS: { accountType: 'LIABILITY', single: true },
  CASH: { accountType: 'ASSET', single: false },
  BANK: { accountType: 'ASSET', single: false },
  INPUT_TAX: { accountType: 'ASSET', single: true },
  OUTPUT_TAX: { accountType: 'LIABILITY', single: true },
  INCOME_TAX_CUSTOMERS: { accountType: 'ASSET', single: true }, // income tax the customers withheld from us
  INCOME_TAX_VENDORS: { accountType: 'LIABILITY', single: true }, // income tax we withhold from vendors
  SRB_WITHHOLDING: { accountType: 'LIABILITY', single: true },
  SALES: { accountType: 'INCOME', single: true }, // the income account sales invoices post to
  PURCHASES: { accountType: 'EXPENSE', single: true }, // the expense account purchase invoices post to
  CUSTOMER_ADVANCES: { accountType: 'LIABILITY', single: true }, // money a customer paid before an invoice (we owe him the goods)
  SUPPLIER_ADVANCES: { accountType: 'ASSET', single: true }, // money we paid a vendor before his bill
  EMPLOYEE_LOANS: { accountType: 'ASSET', single: true }, // money employees owe us for loans paid to them
  EMPLOYEE_ADVANCES: { accountType: 'ASSET', single: true }, // money employees owe us for advances paid to them (taken back from the next salary)
  SALARY_EXPENSE: { accountType: 'EXPENSE', single: true }, // the salary every approved payroll debits
  SALARIES_PAYABLE: { accountType: 'LIABILITY', single: true }, // the net salary owed to the employees until it is paid
  EOBI_PAYABLE: { accountType: 'LIABILITY', single: true }, // EOBI withheld from the salaries
  SALARY_TAX_PAYABLE: { accountType: 'LIABILITY', single: true }, // income tax withheld from the salaries
  EMPLOYEE_DEDUCTIONS: { accountType: 'LIABILITY', single: true }, // other deductions made from the salaries
  EOBI_EMPLOYER_EXPENSE: { accountType: 'EXPENSE', single: true }, // the employer share of the EOBI contribution
};

class Account extends Model {}

function init(sequelize) {
  Account.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      companyId: { type: DataTypes.UUID, allowNull: false },
      code: { type: DataTypes.STRING(20), allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      parentId: { type: DataTypes.UUID, allowNull: true },
      isGroup: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      accountType: { type: DataTypes.STRING(10), allowNull: false },
      normalBalance: { type: DataTypes.STRING(6), allowNull: false },
      subType: { type: DataTypes.STRING(30), allowNull: true },
      controlType: { type: DataTypes.STRING(24), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      // an account the software relies on (default accounts, retained earnings ...): it cannot be deleted, switched off or re-typed; its name may change
      isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      systemKey: { type: DataTypes.STRING(40), allowNull: true },
      // runs against its type (accumulated depreciation, drawings, sales returns): its normal balance is the opposite one
      isContra: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      openingBalance: { type: DataTypes.DECIMAL(18, 2), allowNull: false, defaultValue: 0 },
      openingSide: { type: DataTypes.STRING(6), allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: true },
    },
    { sequelize, modelName: 'Account', tableName: 'accounts' },
  );
  return Account;
}

module.exports = { Account, init, ACCOUNT_TYPES, NORMAL_BALANCE, SUB_TYPES, CONTROL_TYPES };
