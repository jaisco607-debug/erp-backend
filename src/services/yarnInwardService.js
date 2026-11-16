// Weaving > Yarn Inward. One entry = one item card received from a VENDOR (type PURCHASE) or from a CUSTOMER (type OVERHEAD: the customer's own yarn).
//   bags x lbsPerBag = totalLbs;  totalLbs x ratePerLb = amount.  The rate is required for a purchase and optional for overhead yarn.
// Customers and vendors are the common masters of the company (the same tables the other modules use).
const { Op } = require('sequelize');
const { sequelize, YarnInward, YarnItem, YarnCount, YarnBrand, Customer, Vendor } = require('../models');
const AppError = require('../utils/AppError');
const { today } = require('../utils/dates');
const audit = require('./auditService');
const { usedBags } = require('./yarnUsage');

/** Map inwardId -> the purchase invoice (accounts) the entry is on: { id, voucherNo, status }. */
async function invoicesOf(ids, transaction) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await sequelize.query('SELECT y."inwardId", p.id, p."voucherNo", p.status FROM purchase_invoice_yarn_inwards y JOIN purchase_invoices p ON p.id = y."invoiceId" WHERE y."inwardId" IN (:ids)',
    { replacements: { ids }, type: sequelize.QueryTypes.SELECT, transaction });
  for (const r of rows) map.set(r.inwardId, { id: r.id, voucherNo: r.voucherNo, voucherLabel: String(r.voucherNo).padStart(5, '0'), status: r.status });
  return map;
}

const INCLUDE = [
  { model: Customer, as: 'customer', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: Vendor, as: 'vendor', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: Vendor, as: 'directVendor', paranoid: false, attributes: ['id', 'code', 'name'] },
  { model: YarnItem, as: 'item', paranoid: false, include: [
    { model: YarnCount, as: 'yarnCount', paranoid: false, attributes: ['id', 'code', 'name'] },
    { model: YarnBrand, as: 'brand', paranoid: false, attributes: ['id', 'code', 'name'] },
  ] },
];
const n2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => (v == null ? null : Number(v));

// `used` = bags of this entry that already went out on yarn outward challans
const json = (e, used = 0, invoice = null) => {
  const party = e.vendor || e.customer;
  const it = e.item;
  return {
    id: e.id, code: e.code, inwardDate: e.inwardDate,
    type: e.vendorId ? 'PURCHASE' : 'OVERHEAD',
    party: { kind: e.vendorId ? 'VENDOR' : 'CUSTOMER', id: party.id, code: party.code, name: party.name },
    customerId: e.customerId, vendorId: e.vendorId,
    itemId: e.itemId,
    item: { id: it.id, code: it.code, name: `${it.yarnCount.name} - ${it.brand.name} - ${it.packing} - ${it.bags}`, yarnCount: { id: it.yarnCount.id, name: it.yarnCount.name }, brand: { id: it.brand.id, name: it.brand.name }, packing: it.packing, bags: it.bags },
    // yarn the supplier delivered straight to a sizing party: it never came to our factory, so it is not on the gate pass of the sizing challan
    sentDirect: Boolean(e.directVendorId), directVendorId: e.directVendorId || null, directVendor: e.directVendor ? { id: e.directVendor.id, code: e.directVendor.code, name: e.directVendor.name } : null,
    purchaseInvoice: invoice, invoiced: Boolean(invoice),
    bags: e.bags, outwardBags: used, balanceBags: e.bags - used, lbsPerBag: num(e.lbsPerBag), totalLbs: num(e.totalLbs), ratePerLb: num(e.ratePerLb), amount: num(e.amount),
    dcNo: e.dcNo, remarks: e.remarks, createdAt: e.createdAt,
  };
};

const load = (companyId, id, transaction) => YarnInward.findOne({ where: { id, companyId }, include: INCLUDE, transaction });
async function findOr404(req, id, transaction) {
  const row = await load(req.user.companyId, id, transaction);
  if (!row) throw AppError.notFound('Yarn inward');
  return row;
}

/** The party and the item card must be of this company and switched on (an unchanged one on an edit may be off). */
async function checkRefs(companyId, { customerId, vendorId, itemId, directVendorId }, keep, transaction) {
  if (directVendorId) {
    const d = await Vendor.findOne({ where: { id: directVendorId, companyId, module: 'WEAVING' }, transaction });
    if (!d) throw AppError.rule('UNKNOWN_VENDOR', 'The sizing party does not exist', { field: 'directVendorId' });
    if (!d.isActive && directVendorId !== keep.directVendorId) throw AppError.rule('VENDOR_INACTIVE', 'The sizing party is switched off', { field: 'directVendorId' });
  }
  if (vendorId) {
    const v = await Vendor.findOne({ where: { id: vendorId, companyId, module: 'WEAVING' }, transaction });
    if (!v) throw AppError.rule('UNKNOWN_VENDOR', 'This vendor does not exist', { field: 'vendorId' });
    if (!v.isActive && vendorId !== keep.vendorId) throw AppError.rule('VENDOR_INACTIVE', 'This vendor is switched off', { field: 'vendorId' });
  } else {
    const c = await Customer.findOne({ where: { id: customerId, companyId, module: 'WEAVING' }, transaction });
    if (!c) throw AppError.rule('UNKNOWN_CUSTOMER', 'This customer does not exist', { field: 'customerId' });
    if (!c.isActive && customerId !== keep.customerId) throw AppError.rule('CUSTOMER_INACTIVE', 'This customer is switched off', { field: 'customerId' });
  }
  const it = await YarnItem.findOne({ where: { id: itemId, companyId }, transaction });
  if (!it) throw AppError.rule('UNKNOWN_ITEM', 'This item card does not exist', { field: 'itemId' });
  if (!it.isActive && itemId !== keep.itemId) throw AppError.rule('ITEM_INACTIVE', 'This item card is switched off', { field: 'itemId' });
}

/** The money and quantity of one entry: totalLbs = bags x lbsPerBag, amount = totalLbs x rate. */
function work({ bags, lbsPerBag, ratePerLb }) {
  const totalLbs = n2(bags * lbsPerBag);
  const rate = ratePerLb === undefined || ratePerLb === null ? null : Number(ratePerLb);
  return { totalLbs, ratePerLb: rate, amount: rate === null ? null : n2(totalLbs * rate) };
}

/** Dropdown help for the form: the item cards that can be picked (with their data) and today's date. */
async function formData(req) {
  const items = await YarnItem.findAll({ where: { companyId: req.user.companyId, isActive: true }, include: [
    { model: YarnCount, as: 'yarnCount', paranoid: false, attributes: ['id', 'code', 'name'] },
    { model: YarnBrand, as: 'brand', paranoid: false, attributes: ['id', 'code', 'name'] }], order: [['code', 'ASC']] });
  return {
    date: today(),
    // `lbsPerBag` is what the item card says a bag weighs (its `bags` field: 50 or 100): fill the form with it, the user may change it
    items: items.map((it) => ({ id: it.id, code: it.code, name: `${it.yarnCount.name} - ${it.brand.name} - ${it.packing} - ${it.bags}`, yarnCount: { id: it.yarnCount.id, name: it.yarnCount.name }, brand: { id: it.brand.id, name: it.brand.name }, packing: it.packing, bags: it.bags, lbsPerBag: it.bags })),
  };
}

async function list(req, { page, limit, search, type, customerId, vendorId, itemId, dateFrom, dateTo }) {
  const where = { companyId: req.user.companyId };
  if (type === 'PURCHASE') where.vendorId = { [Op.ne]: null };
  if (type === 'OVERHEAD') where.customerId = { [Op.ne]: null };
  if (customerId) where.customerId = customerId;
  if (vendorId) where.vendorId = vendorId;
  if (itemId) where.itemId = itemId;
  if (dateFrom || dateTo) where.inwardDate = { ...(dateFrom ? { [Op.gte]: dateFrom } : {}), ...(dateTo ? { [Op.lte]: dateTo } : {}) };
  if (search) {
    const like = { [Op.iLike]: `%${search.replace(/[\\%_]/g, '\\$&')}%` };
    const or = [{ dcNo: like }, { '$customer.name$': like }, { '$vendor.name$': like }, { '$item.yarnCount.name$': like }, { '$item.brand.name$': like }];
    if (/^\d+$/.test(search)) or.push({ code: Number(search) });
    where[Op.or] = or;
  }
  const { rows, count } = await YarnInward.findAndCountAll({ where, include: INCLUDE, order: [['inwardDate', 'DESC'], ['code', 'DESC']], limit, offset: (page - 1) * limit, distinct: true });
  // totals of the whole filtered list (not just this page)
  const all = await YarnInward.findAll({ where, include: INCLUDE.map((i) => ({ ...i, attributes: [] })), attributes: ['bags', 'totalLbs', 'amount'], raw: true });
  const totals = all.reduce((t, r) => ({ bags: t.bags + Number(r.bags), totalLbs: n2(t.totalLbs + Number(r.totalLbs)), amount: n2(t.amount + Number(r.amount || 0)) }), { bags: 0, totalLbs: 0, amount: 0 });
  const used = await usedBags(rows.map((r) => r.id));
  const invoices = await invoicesOf(rows.map((r) => r.id));
  return { data: rows.map((r) => json(r, used.get(r.id) || 0, invoices.get(r.id) || null)), page, limit, total: count, totals };
}

const get = async (req, id) => {
  const e = await findOr404(req, id);
  return json(e, (await usedBags([id])).get(id) || 0, (await invoicesOf([id])).get(id) || null);
};

async function create(req, data) {
  const { companyId } = req.user;
  if (data.vendorId && (data.ratePerLb === undefined || data.ratePerLb === null)) throw AppError.rule('RATE_REQUIRED', 'The rate per lb is required for a purchase', { field: 'ratePerLb' });
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext($1))', { bind: [`yarn-inward:${companyId}`], transaction });
    await checkRefs(companyId, data, {}, transaction);
    const code = ((await YarnInward.max('code', { where: { companyId }, paranoid: false, transaction })) || 0) + 1;
    const row = await YarnInward.create({
      companyId, code, inwardDate: data.inwardDate || today(), customerId: data.customerId || null, vendorId: data.vendorId || null, itemId: data.itemId, directVendorId: data.directVendorId || null,
      bags: data.bags, lbsPerBag: data.lbsPerBag, ...work(data), dcNo: data.dcNo || null, remarks: data.remarks || null, createdById: req.user.id,
    }, { transaction });
    const out = json(await load(companyId, row.id, transaction));
    await audit.log(req, { action: 'YARN_INWARD_CREATED', entityType: 'YarnInward', entityId: row.id, after: out }, { transaction });
    return out;
  });
}

/** Change an entry. The party can be changed inside its kind only (vendor to vendor, customer to customer): the type of an entry does not change. */
async function update(req, id, changes) {
  const { companyId } = req.user;
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(req, id, transaction);
    const used = (await usedBags([id], { transaction })).get(id) || 0;
    const invoice = (await invoicesOf([id], transaction)).get(id) || null;
    // an entry on a purchase invoice feeds the books: only its DC no and remarks may change (delete the invoice first for the rest)
    if (invoice && Object.keys(changes).some((k) => !['dcNo', 'remarks'].includes(k))) throw AppError.rule('ON_PURCHASE_INVOICE', `This entry is on purchase invoice ${invoice.voucherLabel}: delete that invoice first to change it (only the DC no and remarks can change)`, { invoiceId: invoice.id, voucherNo: invoice.voucherNo });
    const before = json(row, used, invoice);
    if (changes.vendorId && !row.vendorId) throw AppError.rule('TYPE_LOCKED', 'This is an overhead (customer) entry: choose a customer, not a vendor', { field: 'vendorId' });
    if (changes.customerId && !row.customerId) throw AppError.rule('TYPE_LOCKED', 'This is a purchase (vendor) entry: choose a vendor, not a customer', { field: 'customerId' });
    const next = {
      customerId: changes.customerId || row.customerId, vendorId: changes.vendorId || row.vendorId, itemId: changes.itemId || row.itemId,
      bags: changes.bags !== undefined ? changes.bags : row.bags, lbsPerBag: changes.lbsPerBag !== undefined ? changes.lbsPerBag : Number(row.lbsPerBag),
      ratePerLb: changes.ratePerLb !== undefined ? changes.ratePerLb : num(row.ratePerLb),
      directVendorId: changes.directVendorId !== undefined ? changes.directVendorId : row.directVendorId,
    };
    if (next.vendorId && (next.ratePerLb === null || next.ratePerLb === undefined)) throw AppError.rule('RATE_REQUIRED', 'The rate per lb is required for a purchase', { field: 'ratePerLb' });
    // yarn of this entry already went out: its bags cannot go below that, and what the outward challans were made from (item card, lbs per bag, date) stays
    if (used) {
      if (next.bags < used) throw AppError.rule('BELOW_OUTWARD', `${used} bag${used === 1 ? '' : 's'} of this entry already went out: the bags cannot be less than that`, { field: 'bags', outwardBags: used });
      if ((next.directVendorId || null) !== (row.directVendorId || null)) throw AppError.rule('USED_IN_OUTWARD', 'Yarn of this entry already went out: the sizing party it was sent to cannot be changed', { outwardBags: used });
      if (next.itemId !== row.itemId || Number(next.lbsPerBag) !== Number(row.lbsPerBag)) throw AppError.rule('USED_IN_OUTWARD', 'Yarn of this entry already went out: its item card and lbs per bag cannot be changed', { outwardBags: used });
      if (changes.inwardDate && String(changes.inwardDate) > String(row.inwardDate)) throw AppError.rule('USED_IN_OUTWARD', 'Yarn of this entry already went out: the date cannot be moved later', { outwardBags: used });
    }
    await checkRefs(companyId, next, { customerId: row.customerId, vendorId: row.vendorId, itemId: row.itemId, directVendorId: row.directVendorId }, transaction);
    const set = { customerId: next.customerId, vendorId: next.vendorId, itemId: next.itemId, directVendorId: next.directVendorId || null, bags: next.bags, lbsPerBag: next.lbsPerBag, ...work(next) };
    for (const f of ['inwardDate', 'dcNo', 'remarks']) if (changes[f] !== undefined) set[f] = changes[f] === '' ? null : changes[f];
    await YarnInward.update(set, { where: { id, companyId }, transaction });
    const out = json(await load(companyId, id, transaction), used, invoice);
    await audit.log(req, { action: 'YARN_INWARD_UPDATED', entityType: 'YarnInward', entityId: id, before, after: out }, { transaction });
    return out;
  });
}

async function remove(req, id) {
  return sequelize.transaction(async (transaction) => {
    const row = await findOr404(req, id, transaction);
    const invoice = (await invoicesOf([id], transaction)).get(id) || null;
    if (invoice) throw AppError.rule('ON_PURCHASE_INVOICE', `This entry is on purchase invoice ${invoice.voucherLabel}: delete that invoice first`, { invoiceId: invoice.id, voucherNo: invoice.voucherNo });
    const used = (await usedBags([id], { transaction })).get(id) || 0;
    if (used) throw AppError.rule('IN_USE', `${used} bag${used === 1 ? '' : 's'} of this entry went out on a challan: delete or change that challan first`, { outwardBags: used });
    const before = json(row);
    await YarnInward.destroy({ where: { id, companyId: req.user.companyId }, transaction });
    await audit.log(req, { action: 'YARN_INWARD_DELETED', entityType: 'YarnInward', entityId: id, before }, { transaction });
    return { deleted: true, id };
  });
}

module.exports = { list, get, create, update, remove, formData, json, INCLUDE };
