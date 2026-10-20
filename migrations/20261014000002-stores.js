// Step 7: Chemical Store and General Items Store.
//   services           adds GENERAL_STORE (a MODULE) and gives it to every company, like CHEMICAL_STORE
//   vendors            suppliers the stores buy from; one list for both stores, numbered per company
//   store_categories   item categories, separate per store (CHEMICAL / GENERAL)
//   store_brands       item brands, separate per store
//   store_items        what a store keeps: name, unit, category, brand, and the current stock
//                      (stockQty and stockValue; average rate = stockValue / stockQty)
//   store_inwards      one purchase entry (bill) from a vendor. DRAFT until approved; only an approved
//                      entry adds to stock. A draft may have lines without a rate (rate not known yet).
//   store_inward_lines the items of an entry: qty, rate, amount
//   store_moves        every change of stock (IN from an inward, later OUT to departments), the history
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q(`INSERT INTO services (id, code, name, kind, "tracksColour", "sortOrder")
               SELECT gen_random_uuid(), 'GENERAL_STORE', 'General Items Store', 'MODULE', false,
                      COALESCE((SELECT "sortOrder" FROM services WHERE code = 'CHEMICAL_STORE'), 0)
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE code = 'GENERAL_STORE')`);
      await q(`INSERT INTO company_services ("companyId", "serviceId")
               SELECT c.id, s.id FROM companies c CROSS JOIN services s
               WHERE s.code = 'GENERAL_STORE' AND c."deletedAt" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM company_services cs WHERE cs."companyId" = c.id AND cs."serviceId" = s.id)`);
      const common = `
          "createdById" uuid,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now()`;
      const store = `store varchar(10) NOT NULL CHECK (store IN ('CHEMICAL', 'GENERAL'))`;
      await q(`
        CREATE TABLE vendors (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          code integer NOT NULL,
          name varchar(150) NOT NULL,
          phone varchar(30),
          address varchar(300),
          "isActive" boolean NOT NULL DEFAULT true,${common},
          UNIQUE ("companyId", code)
        );
        CREATE UNIQUE INDEX vendors_name ON vendors ("companyId", lower(name));`);
      for (const t of ['store_categories', 'store_brands']) {
        await q(`
          CREATE TABLE ${t} (
            id uuid PRIMARY KEY,
            "companyId" uuid NOT NULL REFERENCES companies(id),
            ${store},
            name varchar(100) NOT NULL,
            "isActive" boolean NOT NULL DEFAULT true,${common}
          );
          CREATE UNIQUE INDEX ${t}_name ON ${t} ("companyId", store, lower(name));`);
      }
      await q(`
        CREATE TABLE store_items (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          ${store},
          name varchar(150) NOT NULL,
          unit varchar(10) NOT NULL,
          "categoryId" uuid REFERENCES store_categories(id),
          "brandId" uuid REFERENCES store_brands(id),
          "stockQty" numeric(16,3) NOT NULL DEFAULT 0,
          "stockValue" numeric(16,2) NOT NULL DEFAULT 0,
          "isActive" boolean NOT NULL DEFAULT true,${common}
        );
        CREATE UNIQUE INDEX store_items_name ON store_items ("companyId", store, lower(name));`);
      await q(`
        CREATE TABLE store_inwards (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          ${store},
          "idNo" integer NOT NULL,
          "ipNo" integer,
          "inwardDate" date NOT NULL,
          "billType" varchar(10) NOT NULL DEFAULT 'OTHER' CHECK ("billType" IN ('GST', 'OTHER')),
          "vendorId" uuid REFERENCES vendors(id),
          "acntNo" varchar(30),
          "dcNo" varchar(50),
          "grnNo" varchar(50),
          notes varchar(500),
          "totalQty" numeric(16,3) NOT NULL DEFAULT 0,
          amount numeric(16,2) NOT NULL DEFAULT 0,
          "salesTax" numeric(16,2) NOT NULL DEFAULT 0,
          "isApproved" boolean NOT NULL DEFAULT false,
          "approvedById" uuid,
          "approvedAt" timestamptz,${common},
          UNIQUE ("companyId", store, "idNo"),
          UNIQUE ("companyId", store, "ipNo")
        );
        CREATE TABLE store_inward_lines (
          id uuid PRIMARY KEY,
          "inwardId" uuid NOT NULL REFERENCES store_inwards(id) ON DELETE CASCADE,
          "itemId" uuid NOT NULL REFERENCES store_items(id),
          qty numeric(16,3) NOT NULL CHECK (qty > 0),
          rate numeric(16,4) CHECK (rate >= 0),
          amount numeric(16,2) NOT NULL DEFAULT 0,
          "sortOrder" integer NOT NULL DEFAULT 0
        );
        CREATE TABLE store_moves (
          id uuid PRIMARY KEY,
          "companyId" uuid NOT NULL REFERENCES companies(id),
          ${store},
          "itemId" uuid NOT NULL REFERENCES store_items(id),
          "moveDate" date NOT NULL,
          kind varchar(20) NOT NULL,
          qty numeric(16,3) NOT NULL,
          value numeric(16,2) NOT NULL,
          "inwardId" uuid REFERENCES store_inwards(id),
          "departmentId" uuid REFERENCES services(id),${common}
        );
        CREATE INDEX store_moves_item ON store_moves ("itemId", "createdAt");`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TABLE store_moves, store_inward_lines, store_inwards, store_items, store_brands, store_categories, vendors;
      DELETE FROM company_services WHERE "serviceId" IN (SELECT id FROM services WHERE code = 'GENERAL_STORE');
      DELETE FROM services WHERE code = 'GENERAL_STORE';`);
  },
};
