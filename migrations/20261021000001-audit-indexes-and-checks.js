// Audit (2026-10-21): database safety, no change to any data.
//   1. every foreign key gets an index on its first column (81 had none: joins and deletes on big tables would get slow).
//   2. money / quantity columns that can never be negative get a CHECK (>= 0). They are added NOT VALID: old rows are
//      not scanned (so the migration cannot fail on old data), every new or changed row is checked.
const NON_NEGATIVE = {
  chemical_issue_batches: ['rate', 'returnedQty', 'value'],
  chemical_request_lines: ['rate', 'returnedQty', 'returnedValue', 'value'],
  chemical_requests: ['returnedValue', 'totalValue'],
  chemical_return_lines: ['rate', 'value'],
  chemical_returns: ['totalValue'],
  grey_lot_thaans: ['takenMeters'],
  grey_lots: ['returnedMeters', 'returnedPieces'],
  grey_returns: ['meters', 'pieces'],
  packing_lists: ['ctnQty', 'grossWeight', 'netWeight'],
  store_batches: ['qtyIn', 'rate', 'valueLeft'],
  store_inward_lines: ['amount'],
  store_inwards: ['amount', 'salesTax', 'totalQty'],
  store_items: ['stockQty', 'stockValue'],
  store_adjustment_lines: ['rate'],
};

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN
            SELECT cl.relname AS tbl, a.attname AS col
            FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
            WHERE k.contype = 'f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = k.conrelid AND i.indkey[0] = k.conkey[1])
          LOOP
            EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (%I)', left('fk_' || r.tbl || '_' || r.col, 63), r.tbl, r.col);
          END LOOP;
        END $$`);
      for (const [table, cols] of Object.entries(NON_NEGATIVE)) {
        for (const col of cols) {
          // eslint-disable-next-line no-await-in-loop
          await q(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_${col.toLowerCase()}_nonneg CHECK ("${col}" >= 0) NOT VALID`);
        }
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      for (const [table, cols] of Object.entries(NON_NEGATIVE)) {
        for (const col of cols) {
          // eslint-disable-next-line no-await-in-loop
          await q(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${col.toLowerCase()}_nonneg`);
        }
      }
      await q(`
        DO $$
        DECLARE r record;
        BEGIN
          FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'fk\\_%' LOOP
            EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
          END LOOP;
        END $$`);
    });
  },
};
