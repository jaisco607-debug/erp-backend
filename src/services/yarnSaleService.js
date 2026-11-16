// Weaving > Yarn Outward > Sale. Purchased yarn sold as it is (no process). The sale is a delivery CHALLAN (takes the yarn out of the stock, gate pass) with the selling rate of every line.
// It has NO invoice fields: the sales invoice is made in the ACCOUNTS (Sales Invoice, kind YARN, built from yarn sales like a cloth invoice is built from gate passes - salesInvoiceService),
// or from here with "Generate invoice", which makes the draft invoice for this sale (the accountant approves it in the accounts).
//   a sale that is on an invoice cannot be changed or deleted (the invoice must be deleted first): its amount feeds the books.
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const AppError = require('../utils/AppError');
const audit = require('./auditService');
const credit = require('./creditService');
const outwards = require('./yarnOutwardService');
const salesInvoices = require('./salesInvoiceService');
const { round } = require('../utils/money');

const TYPE = 'SALE';
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const label = (n) => String(n).padStart(5, '0');
const STATUS_TEXT = { UNAPPROVED: 'Un-approved', APPROVED: 'Approved' };

/** The sales invoice a sale is on (null when it is not invoiced). */
async function invoiceOf(saleId, transaction) {
  const [i] = await q(`SELECT i.id, i."invoiceNo", i."voucherNo", i.status, i."netAmount"::float AS net FROM sales_invoice_yarn_sales y JOIN sales_invoices i ON i.id = y."invoiceId" WHERE y."outwardId" = :saleId`, { saleId }, transaction);
  return i ? { id: i.id, invoiceNo: i.invoiceNo, invoiceLabel: label(i.invoiceNo), voucherNo: i.voucherNo, voucherLabel: label(i.voucherNo), status: i.status, statusText: STATUS_TEXT[i.status], net: i.net } : null;
}

/** The sale (the challan with the rate and amount of every line) and the invoice it is on, if any. */
async function get(req, saleId, transaction) {
  const challan = await outwards.get(req, TYPE, saleId);
  const invoice = await invoiceOf(saleId, transaction);
  return { ...challan, invoiced: Boolean(invoice), invoice, canEdit: !invoice, canDelete: !invoice };
}

async function assertNotInvoiced(saleId, transaction) {
  const inv = await invoiceOf(saleId, transaction);
  if (inv) throw AppError.rule('SALE_INVOICED', `This sale is on sales invoice ${inv.invoiceLabel}: delete that invoice first to change or delete the sale`, { invoiceId: inv.id, invoiceNo: inv.invoiceNo, status: inv.status });
}

function options() {
  return { taxRates: [0, 5, 10, 15, 18], defaultTaxRate: 18 };
}

async function list(req, { page, limit, search, dateFrom, dateTo, customerId, invoiced }) {
  const where = ['o."companyId" = :companyId', 'o."deletedAt" IS NULL', "o.type = 'SALE'"];
  const r = { companyId: req.user.companyId };
  if (dateFrom) { where.push('o."outwardDate" >= :dateFrom'); r.dateFrom = dateFrom; }
  if (dateTo) { where.push('o."outwardDate" <= :dateTo'); r.dateTo = dateTo; }
  if (customerId) { where.push('o."customerId" = :customerId'); r.customerId = customerId; }
  if (invoiced !== undefined) where.push(`${invoiced ? '' : 'NOT '}EXISTS (SELECT 1 FROM sales_invoice_yarn_sales y WHERE y."outwardId" = o.id)`);
  if (search) {
    r.like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    r.n = /^\d+$/.test(search.trim()) ? Number(search.trim()) : -1;
    where.push('(c.name ILIKE :like OR o.description ILIKE :like OR o."challanNo" = :n)');
  }
  const base = `FROM yarn_outwards o JOIN customers c ON c.id = o."customerId" WHERE ${where.join(' AND ')}`;
  const [sum] = await q(`SELECT count(*)::int AS sales, COALESCE((SELECT SUM(l.bags) FROM yarn_outward_lines l WHERE l."outwardId" IN (SELECT o.id ${base})), 0)::int AS bags,
      COALESCE((SELECT SUM(l.lbs) FROM yarn_outward_lines l WHERE l."outwardId" IN (SELECT o.id ${base})), 0)::float AS lbs,
      COALESCE((SELECT SUM(l.amount) FROM yarn_outward_lines l WHERE l."outwardId" IN (SELECT o.id ${base})), 0)::float AS amount ${base}`, r);
  const rows = await q(`SELECT o.id, o."challanNo", to_char(o."outwardDate", 'YYYY-MM-DD') AS "outwardDate", o.description, c.id AS "customerId", c.name AS "customerName",
      (SELECT COALESCE(SUM(l.bags), 0)::int FROM yarn_outward_lines l WHERE l."outwardId" = o.id) AS "totalBags", (SELECT COALESCE(SUM(l.lbs), 0)::float FROM yarn_outward_lines l WHERE l."outwardId" = o.id) AS "totalLbs",
      (SELECT COALESCE(SUM(l.amount), 0)::float FROM yarn_outward_lines l WHERE l."outwardId" = o.id) AS "totalAmount",
      i.id AS "invoiceId", i."invoiceNo", i."voucherNo", i.status
    ${base.replace('WHERE', 'LEFT JOIN sales_invoice_yarn_sales ys ON ys."outwardId" = o.id LEFT JOIN sales_invoices i ON i.id = ys."invoiceId" WHERE')}
    ORDER BY o."outwardDate" DESC, o."challanNo" DESC LIMIT :limit OFFSET :offset`, { ...r, limit, offset: (page - 1) * limit });
  return {
    data: rows.map((x) => ({
      id: x.id, challanNo: x.challanNo, challanText: label(x.challanNo), outwardDate: x.outwardDate, description: x.description, customer: { id: x.customerId, name: x.customerName },
      totalBags: x.totalBags, totalLbs: round(x.totalLbs), totalAmount: round(x.totalAmount), invoiced: Boolean(x.invoiceId),
      invoice: x.invoiceId ? { id: x.invoiceId, invoiceNo: x.invoiceNo, invoiceLabel: label(x.invoiceNo), voucherNo: x.voucherNo, voucherLabel: label(x.voucherNo), status: x.status, statusText: STATUS_TEXT[x.status] } : null,
      canEdit: !x.invoiceId, canDelete: !x.invoiceId,
    })),
    page, limit, total: sum.sales, summary: { sales: sum.sales, bags: sum.bags, lbs: round(sum.lbs), amount: round(sum.amount) },
  };
}

async function create(req, data) {
  const sale = await outwards.create(req, TYPE, { customerId: data.customerId, outwardDate: data.outwardDate, description: data.description, lines: data.lines });
  await audit.log(req, { action: 'YARN_SALE_CREATED', entityType: 'YarnSale', entityId: sale.id, after: { challanNo: sale.challanNo, customerId: data.customerId, bags: sale.totalBags, lbs: sale.totalLbs, amount: sale.totalAmount } });
  return get(req, sale.id);
}

async function update(req, saleId, changes) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `sales:${req.user.companyId}` }, transaction });
    await assertNotInvoiced(saleId, transaction);
    await outwards.update(req, TYPE, saleId, changes, { transaction });
  });
  return get(req, saleId);
}

async function remove(req, saleId) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `sales:${req.user.companyId}` }, transaction });
    await assertNotInvoiced(saleId, transaction);
    return outwards.remove(req, TYPE, saleId, { transaction });
  });
}

/** "Generate invoice": makes the draft YARN sales invoice of this sale (the same as choosing it in Accounts > Sales Invoice). Approving it is done in the accounts. */
async function generateInvoice(req, saleId, { taxRate, invoiceDate, dueDate } = {}) {
  const sale = await outwards.get(req, TYPE, saleId);
  const existing = await invoiceOf(saleId);
  if (existing) throw AppError.rule('ALREADY_INVOICED', `This sale is already on sales invoice ${existing.invoiceLabel}`, { invoiceId: existing.id, invoiceNo: existing.invoiceNo });
  const invoice = await salesInvoices.create(req, { customerId: sale.party.id, yarnSaleIds: [saleId], taxRate, invoiceDate: invoiceDate || sale.outwardDate, dueDate, invoiceDetails: sale.description || undefined });
  return { sale: await get(req, saleId), invoice };
}

const creditOf = (req, customerId) => credit.publicStatus(req, 'CUSTOMER', customerId);

module.exports = { options, list, get, create, update, remove, generateInvoice, creditOf };
