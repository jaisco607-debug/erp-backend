'use strict';
// Credit terms (owner 2026-10-29): customers and vendors get a credit limit (optional, empty = no limit) and credit days (0 = due the same day).
// The sales invoice gets a due date like the purchase invoice already has (empty = invoice date + the customer's credit days).
module.exports = {
  async up(q) {
    const run = (sql) => q.sequelize.query(sql);
    for (const t of ['customers', 'vendors']) {
      await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "creditLimit" numeric(18,2) CHECK ("creditLimit" IS NULL OR "creditLimit" >= 0)`);
      await run(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS "creditDays" integer NOT NULL DEFAULT 0 CHECK ("creditDays" >= 0 AND "creditDays" <= 3650)`);
    }
    await run('ALTER TABLE sales_invoices ADD COLUMN IF NOT EXISTS "dueDate" date');
    await run(`ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_due_after_date CHECK ("dueDate" IS NULL OR "dueDate" >= "invoiceDate")`);
  },
  async down(q) {
    const run = (sql) => q.sequelize.query(sql);
    await run('ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_due_after_date');
    await run('ALTER TABLE sales_invoices DROP COLUMN IF EXISTS "dueDate"');
    for (const t of ['customers', 'vendors']) {
      await run(`ALTER TABLE ${t} DROP COLUMN IF EXISTS "creditDays"`);
      await run(`ALTER TABLE ${t} DROP COLUMN IF EXISTS "creditLimit"`);
    }
  },
};
