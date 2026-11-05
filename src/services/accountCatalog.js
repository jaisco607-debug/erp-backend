// Fixed lists of the Chart of Accounts: the folders, the "what do you want to add?" presets of the wizard, the business templates,
// and the system accounts. Plain data: no database here.
//
// Numbering rules (also used by GET /accounts/next-code):
//   top accounts   Asset 1000, Liability 2000, Equity 3000, Income 4000, Cost of Sales 5000, Operating Expenses 6000 (+100 until free)
//   group inside a top account   parent + 100
//   posting account inside a top account   parent + 1
//   deeper   the highest sibling + 1
// 5000 and 6000 are both of type EXPENSE: 5000 = Cost of Goods Sold (subType COST_OF_SALES), 6000 = Operating Expenses.

const TOP_CODES = { ASSET: 1000, LIABILITY: 2000, EQUITY: 3000, INCOME: 4000, COST_OF_SALES: 5000, OPERATING_EXPENSE: 6000 };

/** What a system account (systemKey) is, and the control type it carries so the accounting engine can find it. */
const SYSTEM_KEYS = {
  AR_CONTROL: { controlType: 'CUSTOMERS', label: 'Accounts Receivable' },
  AP_CONTROL: { controlType: 'SUPPLIERS', label: 'Accounts Payable' },
  DEFAULT_SALES: { controlType: 'SALES', label: 'Default Sales' },
  DEFAULT_PURCHASES: { controlType: 'PURCHASES', label: 'Purchases / Cost of Goods Sold' },
  INPUT_TAX: { controlType: 'INPUT_TAX', label: 'Input Sales Tax' },
  OUTPUT_TAX: { controlType: 'OUTPUT_TAX', label: 'Output Sales Tax' },
  INCOME_TAX_CUSTOMERS: { controlType: 'INCOME_TAX_CUSTOMERS', label: 'Income Tax - Customers' },
  INCOME_TAX_VENDORS: { controlType: 'INCOME_TAX_VENDORS', label: 'Income Tax - Vendors' },
  CUSTOMER_ADVANCES: { controlType: 'CUSTOMER_ADVANCES', label: 'Customer Advances' },
  SUPPLIER_ADVANCES: { controlType: 'SUPPLIER_ADVANCES', label: 'Supplier Advances' },
  EMPLOYEE_LOANS: { controlType: 'EMPLOYEE_LOANS', label: 'Employee Loans' },
  EMPLOYEE_ADVANCES: { controlType: 'EMPLOYEE_ADVANCES', label: 'Employee Advances' },
  SALARY_EXPENSE: { controlType: 'SALARY_EXPENSE', label: 'Salaries & Wages' },
  SALARIES_PAYABLE: { controlType: 'SALARIES_PAYABLE', label: 'Salaries Payable' },
  EOBI_PAYABLE: { controlType: 'EOBI_PAYABLE', label: 'EOBI Payable' },
  SALARY_TAX_PAYABLE: { controlType: 'SALARY_TAX_PAYABLE', label: 'Income Tax Payable - Salaries' },
  EMPLOYEE_DEDUCTIONS: { controlType: 'EMPLOYEE_DEDUCTIONS', label: 'Other Employee Deductions' },
  EOBI_EMPLOYER_EXPENSE: { controlType: 'EOBI_EMPLOYER_EXPENSE', label: 'EOBI Employer Contribution' },
  RETAINED_EARNINGS: { controlType: null, label: 'Retained Earnings' },
  CURRENT_YEAR_EARNINGS: { controlType: null, label: 'Current Year Earnings' },
  ROUNDING: { controlType: null, label: 'Rounding Difference' },
  OPENING_BALANCE_EQUITY: { controlType: null, label: 'Opening Balance Equity' },
};
/** The control type to the system key it gets when the system makes or adopts the account. */
const SYSTEM_KEY_OF_CONTROL = { CUSTOMERS: 'AR_CONTROL', SUPPLIERS: 'AP_CONTROL', SALES: 'DEFAULT_SALES', PURCHASES: 'DEFAULT_PURCHASES', INPUT_TAX: 'INPUT_TAX', OUTPUT_TAX: 'OUTPUT_TAX',
  INCOME_TAX_CUSTOMERS: 'INCOME_TAX_CUSTOMERS', INCOME_TAX_VENDORS: 'INCOME_TAX_VENDORS', CUSTOMER_ADVANCES: 'CUSTOMER_ADVANCES', SUPPLIER_ADVANCES: 'SUPPLIER_ADVANCES',
  EMPLOYEE_LOANS: 'EMPLOYEE_LOANS', EMPLOYEE_ADVANCES: 'EMPLOYEE_ADVANCES', SALARY_EXPENSE: 'SALARY_EXPENSE', SALARIES_PAYABLE: 'SALARIES_PAYABLE', EOBI_PAYABLE: 'EOBI_PAYABLE', SALARY_TAX_PAYABLE: 'SALARY_TAX_PAYABLE',
  EMPLOYEE_DEDUCTIONS: 'EMPLOYEE_DEDUCTIONS', EOBI_EMPLOYER_EXPENSE: 'EOBI_EMPLOYER_EXPENSE' };

const folder = (code, name, accountType, subType, parentCode = null) => ({ code, name, accountType, subType, isGroup: true, parentCode });
/** The folders presets and templates sit in. */
const FOLDERS = {
  1000: folder('1000', 'Assets', 'ASSET', null),
  1100: folder('1100', 'Current Assets', 'ASSET', 'CURRENT_ASSET', '1000'),
  1200: folder('1200', 'Fixed Assets', 'ASSET', 'FIXED_ASSET', '1000'),
  2000: folder('2000', 'Liabilities', 'LIABILITY', null),
  2100: folder('2100', 'Current Liabilities', 'LIABILITY', 'CURRENT_LIABILITY', '2000'),
  2200: folder('2200', 'Long-term Liabilities', 'LIABILITY', 'LONG_TERM_LIABILITY', '2000'),
  3000: folder('3000', 'Equity', 'EQUITY', null),
  4000: folder('4000', 'Income', 'INCOME', null),
  5000: folder('5000', 'Cost of Sales', 'EXPENSE', 'COST_OF_SALES'),
  6000: folder('6000', 'Operating Expenses', 'EXPENSE', 'OPERATING_EXPENSE'),
};

/** The cards of the "add an account" wizard. suggestedParentCode = the folder the account normally sits in. */
const preset = (key, label, description, icon, accountType, subType, controlType, isContra, suggestedParentCode, defaultName) => (
  { key, label, description, icon, accountType, subType, controlType, isContra, suggestedParentCode, defaultName });
const PRESETS = [
  preset('cash_in_hand', 'Cash in hand', 'Cash kept in the office or in the till', 'cash', 'ASSET', 'CURRENT_ASSET', 'CASH', false, '1100', 'Cash in Hand'),
  preset('bank_account', 'Bank account', 'Money in a bank account', 'bank', 'ASSET', 'CURRENT_ASSET', 'BANK', false, '1100', 'Bank Account'),
  preset('customers_owe_us', 'Customers who owe us', 'What customers have still to pay us (Accounts Receivable)', 'users', 'ASSET', 'CURRENT_ASSET', 'CUSTOMERS', false, '1100', 'Accounts Receivable'),
  preset('suppliers_we_owe', 'Suppliers we owe', 'What we still have to pay our suppliers (Accounts Payable)', 'truck', 'LIABILITY', 'CURRENT_LIABILITY', 'SUPPLIERS', false, '2100', 'Accounts Payable'),
  preset('inventory', 'Inventory / stock', 'Goods and materials we hold', 'box', 'ASSET', 'CURRENT_ASSET', null, false, '1100', 'Inventory'),
  preset('equipment', 'Equipment', 'Machines, furniture, vehicles, computers', 'tool', 'ASSET', 'FIXED_ASSET', null, false, '1200', 'Equipment'),
  preset('accumulated_depreciation', 'Accumulated depreciation', 'Wear and tear of equipment, taken off its value', 'trending-down', 'ASSET', 'FIXED_ASSET', null, true, '1200', 'Accumulated Depreciation'),
  preset('loan', 'Loan', 'Money borrowed that we pay back over time', 'landmark', 'LIABILITY', 'LONG_TERM_LIABILITY', null, false, '2200', 'Loan'),
  preset('tax_payable', 'Tax payable', 'Sales tax collected that we owe to the government', 'receipt', 'LIABILITY', 'CURRENT_LIABILITY', 'OUTPUT_TAX', false, '2100', 'Sales Tax Payable'),
  preset('owner_investment', 'Owner investment', 'Money the owner put into the business', 'user-plus', 'EQUITY', 'CAPITAL', null, false, '3000', "Owner's Capital"),
  preset('owner_drawings', 'Owner drawings', 'Money the owner took out for personal use', 'user-minus', 'EQUITY', 'DRAWINGS', null, true, '3000', 'Owner Drawings'),
  preset('sales_income', 'Sales income', 'Money earned from selling goods or services', 'shopping-cart', 'INCOME', 'OPERATING_REVENUE', 'SALES', false, '4000', 'Sales'),
  preset('sales_returns', 'Sales returns', 'Goods customers sent back, taken off sales', 'undo', 'INCOME', 'OPERATING_REVENUE', null, true, '4000', 'Sales Returns'),
  preset('other_income', 'Other income', 'Income that is not from sales (interest, scrap ...)', 'plus-circle', 'INCOME', 'OTHER_INCOME', null, false, '4000', 'Other Income'),
  preset('cost_of_goods_sold', 'Cost of goods sold', 'What the goods we sold cost us', 'package', 'EXPENSE', 'COST_OF_SALES', null, false, '5000', 'Cost of Goods Sold'),
  preset('rent', 'Rent', 'Rent of shop, office or factory', 'home', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Rent'),
  preset('salaries', 'Salaries', 'Salaries and wages of staff', 'briefcase', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Salaries'),
  preset('utilities', 'Electricity / utilities', 'Electricity, gas and water bills', 'zap', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Electricity & Utilities'),
  preset('internet_phone', 'Internet / phone', 'Internet and phone bills', 'wifi', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Internet & Phone'),
  preset('bank_charges', 'Bank charges', 'Fees and charges taken by the bank', 'credit-card', 'EXPENSE', 'FINANCE_COST', null, false, '6000', 'Bank Charges'),
  preset('transport', 'Transport', 'Freight, fuel and delivery costs', 'car', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Transport'),
  preset('misc_expense', 'Miscellaneous expense', 'Small expenses that fit nowhere else', 'more-horizontal', 'EXPENSE', 'OPERATING_EXPENSE', null, false, '6000', 'Miscellaneous Expense'),
];

// ---- business templates -----------------------------------------------------------------------------------------------------------
const acc = (code, name, parentCode, accountType, extra = {}) => ({
  code, name, parentCode, accountType, isGroup: false, subType: null, controlType: null, isContra: false, systemKey: null, ...extra,
});
const grp = (f) => ({ ...f, controlType: null, isContra: false, systemKey: null });
const sys = (key, extra = {}) => ({ systemKey: key, controlType: SYSTEM_KEYS[key].controlType, ...extra });

/** Every template starts from this list; a template changes names and adds accounts. */
const baseAccounts = () => [
  grp(FOLDERS[1000]), grp(FOLDERS[1100]),
  acc('1101', 'Cash in Hand', '1100', 'ASSET', { subType: 'CURRENT_ASSET', controlType: 'CASH' }),
  acc('1102', 'Bank Account', '1100', 'ASSET', { subType: 'CURRENT_ASSET', controlType: 'BANK' }),
  acc('1103', 'Accounts Receivable', '1100', 'ASSET', { subType: 'CURRENT_ASSET', ...sys('AR_CONTROL') }),
  acc('1104', 'Input Sales Tax', '1100', 'ASSET', { subType: 'CURRENT_ASSET', ...sys('INPUT_TAX') }),
  acc('1108', 'Income Tax - Customers', '1100', 'ASSET', { subType: 'CURRENT_ASSET', ...sys('INCOME_TAX_CUSTOMERS') }),
  acc('1109', 'Supplier Advances', '1100', 'ASSET', { subType: 'CURRENT_ASSET', ...sys('SUPPLIER_ADVANCES') }),
  grp(FOLDERS[1200]),
  acc('1201', 'Equipment', '1200', 'ASSET', { subType: 'FIXED_ASSET' }),
  acc('1202', 'Accumulated Depreciation', '1200', 'ASSET', { subType: 'FIXED_ASSET', isContra: true }),
  grp(FOLDERS[2000]), grp(FOLDERS[2100]),
  acc('2101', 'Accounts Payable', '2100', 'LIABILITY', { subType: 'CURRENT_LIABILITY', ...sys('AP_CONTROL') }),
  acc('2102', 'Output Sales Tax', '2100', 'LIABILITY', { subType: 'CURRENT_LIABILITY', ...sys('OUTPUT_TAX') }),
  acc('2103', 'Accrued Expenses', '2100', 'LIABILITY', { subType: 'CURRENT_LIABILITY' }),
  acc('2104', 'Income Tax - Vendors', '2100', 'LIABILITY', { subType: 'CURRENT_LIABILITY', ...sys('INCOME_TAX_VENDORS') }),
  acc('2105', 'Customer Advances', '2100', 'LIABILITY', { subType: 'CURRENT_LIABILITY', ...sys('CUSTOMER_ADVANCES') }),
  grp(FOLDERS[2200]),
  acc('2201', 'Loan', '2200', 'LIABILITY', { subType: 'LONG_TERM_LIABILITY' }),
  grp(FOLDERS[3000]),
  acc('3001', "Owner's Capital", '3000', 'EQUITY', { subType: 'CAPITAL' }),
  acc('3002', 'Owner Drawings', '3000', 'EQUITY', { subType: 'DRAWINGS', isContra: true }),
  acc('3003', 'Retained Earnings', '3000', 'EQUITY', { subType: 'RETAINED_EARNINGS', ...sys('RETAINED_EARNINGS') }),
  acc('3004', 'Current Year Earnings', '3000', 'EQUITY', { subType: 'RETAINED_EARNINGS', ...sys('CURRENT_YEAR_EARNINGS') }),
  acc('3005', 'Opening Balance Equity', '3000', 'EQUITY', { subType: 'CAPITAL', ...sys('OPENING_BALANCE_EQUITY') }),
  grp(FOLDERS[4000]),
  acc('4001', 'Sales', '4000', 'INCOME', { subType: 'OPERATING_REVENUE', ...sys('DEFAULT_SALES') }),
  acc('4002', 'Sales Returns', '4000', 'INCOME', { subType: 'OPERATING_REVENUE', isContra: true }),
  acc('4003', 'Other Income', '4000', 'INCOME', { subType: 'OTHER_INCOME' }),
  grp(FOLDERS[5000]),
  acc('5001', 'Cost of Goods Sold', '5000', 'EXPENSE', { subType: 'COST_OF_SALES', ...sys('DEFAULT_PURCHASES') }),
  grp(FOLDERS[6000]),
  acc('6001', 'Rent', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6002', 'Salaries', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6003', 'Electricity & Utilities', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6004', 'Internet & Phone', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6005', 'Bank Charges', '6000', 'EXPENSE', { subType: 'FINANCE_COST' }),
  acc('6006', 'Transport', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6007', 'Miscellaneous Expense', '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' }),
  acc('6008', 'Rounding Difference', '6000', 'EXPENSE', { subType: 'OTHER_EXPENSE', ...sys('ROUNDING') }),
];

const rename = (list, code, name) => list.map((a) => (a.code === code ? { ...a, name } : a));
const stock = (code, name) => acc(code, name, '1100', 'ASSET', { subType: 'CURRENT_ASSET' });
const cost = (code, name) => acc(code, name, '5000', 'EXPENSE', { subType: 'COST_OF_SALES' });
const opex = (code, name) => acc(code, name, '6000', 'EXPENSE', { subType: 'OPERATING_EXPENSE' });

const TEMPLATES = [
  {
    key: 'shop', label: 'Shop / Trading', description: 'Buys goods and sells them: stock, sales and cost of goods sold.',
    accounts: () => [...baseAccounts(), stock('1105', 'Inventory'), cost('5002', 'Freight Inward'), opex('6009', 'Shop Expenses')],
  },
  {
    key: 'service', label: 'Service business', description: 'Sells time and skills: consulting, repairs, agencies. No stock.',
    accounts: () => [...rename(baseAccounts(), '4001', 'Service Income'), opex('6009', 'Software & Subscriptions')],
  },
  {
    key: 'restaurant', label: 'Restaurant / Food', description: 'Food and beverage sales with the cost of what is cooked and served.',
    accounts: () => [
      ...rename(rename(baseAccounts(), '4001', 'Food Sales'), '5001', 'Cost of Food & Beverages'),
      acc('4004', 'Beverage Sales', '4000', 'INCOME', { subType: 'OPERATING_REVENUE' }), stock('1105', 'Food & Beverage Stock'), opex('6009', 'Kitchen Gas & Fuel'),
    ],
  },
  {
    key: 'manufacturing', label: 'Manufacturing', description: 'Makes goods: raw material, work in progress, finished goods, direct labour and factory overhead.',
    accounts: () => [
      ...baseAccounts(), stock('1105', 'Raw Material'), stock('1106', 'Work in Progress'), stock('1107', 'Finished Goods'),
      cost('5002', 'Direct Labour'), cost('5003', 'Factory Overhead'), opex('6009', 'Repairs & Maintenance'),
    ],
  },
  { key: 'other', label: 'Other business', description: 'The standard accounts every business needs. Add the rest yourself.', accounts: baseAccounts },
];

/** The roles of the default accounts (the tab "Default accounts"): an account gets one of these roles only there, never from the Chart of Accounts screen. */
const DEFAULT_ROLE_KEYS = Object.keys(SYSTEM_KEY_OF_CONTROL);

module.exports = { TOP_CODES, SYSTEM_KEYS, SYSTEM_KEY_OF_CONTROL, DEFAULT_ROLE_KEYS, FOLDERS, PRESETS, TEMPLATES };
