// Puts the default chemical catalog (src/data/chemicalCatalog.js) into a company's Chemical Store:
// every category (sub-categories as "GROUP / SUB") and its items, unit KG. Rows that already exist
// (same name, any case) are kept as they are, so running it again adds only what is missing.
const CATALOG = require('../data/chemicalCatalog');

function rows() {
  const out = [];
  for (const g of CATALOG) {
    out.push({ category: g.name, items: g.items || [] });
    for (const s of g.subCategories || []) out.push({ category: `${g.name} / ${s.name}`, items: s.items });
  }
  return out;
}

/** Plain SQL so the same code works from a migration and from the app. */
async function seed(sequelize, companyId, transaction) {
  const q = (sql, bind) => sequelize.query(sql, { bind, transaction });
  let items = 0;
  for (const { category, items: names } of rows()) {
    await q(`INSERT INTO store_categories (id, "companyId", store, name)
             SELECT gen_random_uuid(), $1::uuid, 'CHEMICAL', $2::varchar
             WHERE NOT EXISTS (SELECT 1 FROM store_categories WHERE "companyId" = $1::uuid AND store = 'CHEMICAL' AND lower(name) = lower($2::varchar))`, [companyId, category]);
    const [[cat]] = await q(`SELECT id FROM store_categories WHERE "companyId" = $1::uuid AND store = 'CHEMICAL' AND lower(name) = lower($2::varchar)`, [companyId, category]);
    for (const name of [...new Set(names.map((n) => n.trim()))]) {
      const [, n] = await q(`INSERT INTO store_items (id, "companyId", store, name, unit, "categoryId")
               SELECT gen_random_uuid(), $1::uuid, 'CHEMICAL', $2::varchar, 'KG', $3::uuid
               WHERE NOT EXISTS (SELECT 1 FROM store_items WHERE "companyId" = $1::uuid AND store = 'CHEMICAL'
                                 AND "categoryId" = $3::uuid AND lower(name) = lower($2::varchar))`, [companyId, name, cat.id]);
      items += n || 0;
    }
  }
  return { items };
}

module.exports = { seed, rows };
