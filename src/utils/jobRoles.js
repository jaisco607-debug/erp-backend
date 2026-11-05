// The job roles a client admin can give an employee (a label for who the person is and a way to filter the list; it gives no permissions:
// what the person can do comes only from the services given to them). Order = the order of the dropdown.
const JOB_ROLES = [
  ['EMPLOYEE', 'Employee'],
  ['SUPERVISOR', 'Supervisor'],
  ['ASSISTANT_MANAGER', 'Assistant Manager'],
  ['MANAGER', 'Manager'],
  ['DEPARTMENT_MANAGER', 'Department Manager'],
  ['GENERAL_MANAGER', 'General Manager'],
  ['PRODUCTION_MANAGER', 'Production Manager'],
  ['PRODUCTION_SUPERVISOR', 'Production Supervisor'],
  ['QUALITY_CONTROLLER', 'Quality Controller'],
  ['STORE_MANAGER', 'Store Manager'],
  ['STORE_KEEPER', 'Store Keeper'],
  ['STORE_INVENTORY_EMPLOYEE', 'Store Inventory Employee'],
  ['DISPATCH_INCHARGE', 'Dispatch Incharge'],
  ['ASSISTANT_ACCOUNTANT', 'Assistant Accountant'],
  ['ACCOUNTANT', 'Accountant'],
  ['ACCOUNTS_MANAGER', 'Accounts Manager'],
  ['FINANCE', 'Finance'],
  ['FINANCE_MANAGER', 'Finance Manager'],
  ['CASHIER', 'Cashier'],
  ['AUDITOR', 'Auditor'],
  ['SALES_MANAGER', 'Sales Manager'],
  ['SALES_EXECUTIVE', 'Sales Executive'],
  ['PURCHASE_OFFICER', 'Purchase Officer'],
  ['HR_MANAGER', 'HR Manager'],
  ['HR_OFFICER', 'HR Officer'],
  ['PAYROLL_OFFICER', 'Payroll Officer'],
  ['DATA_ENTRY_OPERATOR', 'Data Entry Operator'],
].map(([code, label]) => ({ code, label }));

const CODES = JOB_ROLES.map((r) => r.code);
const DEFAULT_JOB_ROLE = 'EMPLOYEE';
const LABEL = Object.fromEntries(JOB_ROLES.map((r) => [r.code, r.label]));

module.exports = { JOB_ROLES, CODES, DEFAULT_JOB_ROLE, labelOf: (code) => LABEL[code] || null };
