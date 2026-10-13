'use strict';
// Step 2b tables:
//   services           what the platform offers (Grey store, Dyeing, Folding ...); super admin can add more
//   companies          client companies; each has a login code, e.g. "waqas-textile"
//   company_services   which services a company has been given
// Also: users.companyId now points to companies, and an email only has to be unique inside its company
// (super admins: unique among super admins), because company users log in with company code + email.

const SERVICES = [
  // code, name, kind, tracksColour
  ['GREY_STORE', 'Grey Store', 'MODULE', true],
  ['SO_CARD', 'SO / Travel Card', 'MODULE', true],
  ['SINGEING', 'Singeing', 'PROCESS', true],
  ['DYEING', 'Dyeing', 'PROCESS', true],
  ['DRYER', 'Dryer', 'PROCESS', false],
  ['FINISHING', 'Finishing', 'PROCESS', true],
  ['STITCHING', 'Stitching', 'PROCESS', true],
  ['CUTTING', 'Cutting', 'PROCESS', true],
  ['PRINTING', 'Printing', 'PROCESS', true],
  ['STENTER', 'Stenter', 'PROCESS', true],
  ['COMPACTING', 'Compacting', 'PROCESS', true],
  ['FOLDING', 'Folding', 'FOLDING', true],
  ['CHEMICAL_STORE', 'Chemical Store', 'MODULE', false],
  ['PACKING', 'Packing List', 'MODULE', true],
  ['GATE_PASS', 'Gate Pass', 'MODULE', false],
];

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await queryInterface.createTable('services', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      code: { type: Sequelize.STRING(40), allowNull: false, unique: true },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // MODULE = a screen like Grey Store or Gate Pass; PROCESS = a department; FOLDING = grading into A/B/CP
      kind: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'PROCESS' },
      // Whether job sheets of this service show a colour column (Dryer does not)
      tracksColour: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await q(`ALTER TABLE services ADD CONSTRAINT services_kind_check CHECK (kind IN ('MODULE', 'PROCESS', 'FOLDING'))`);
    await q(`ALTER TABLE services ADD CONSTRAINT services_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]*$')`);
    let order = 10;
    for (const [code, name, kind, colour] of SERVICES) {
      await queryInterface.sequelize.query(
        'INSERT INTO services (code, name, kind, "tracksColour", "sortOrder") VALUES ($1, $2, $3, $4, $5)',
        { bind: [code, name, kind, colour, order] },
      );
      order += 10;
    }

    await queryInterface.createTable('companies', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
      name: { type: Sequelize.STRING(150), allowNull: false },
      // Typed on the login screen by the company's admins and users. Small letters, digits and dashes.
      code: { type: Sequelize.STRING(50), allowNull: false, unique: true },
      contactPerson: { type: Sequelize.STRING(120), allowNull: true },
      phone: { type: Sequelize.STRING(30), allowNull: true },
      address: { type: Sequelize.STRING(300), allowNull: true },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdById: { type: Sequelize.UUID, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });
    await q(`ALTER TABLE companies ADD CONSTRAINT companies_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`);

    await queryInterface.createTable('company_services', {
      companyId: {
        type: Sequelize.UUID, allowNull: false, primaryKey: true,
        references: { model: 'companies', key: 'id' }, onDelete: 'CASCADE',
      },
      serviceId: {
        type: Sequelize.UUID, allowNull: false, primaryKey: true,
        references: { model: 'services', key: 'id' }, onDelete: 'RESTRICT',
      },
      givenById: { type: Sequelize.UUID, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    });

    // users: link to companies, and email unique per company instead of in the whole system
    await q(`ALTER TABLE users ADD CONSTRAINT users_company_fk FOREIGN KEY ("companyId") REFERENCES companies(id) ON DELETE RESTRICT`);
    await q(`DROP INDEX users_email_unique`);
    await q(`CREATE UNIQUE INDEX users_super_admin_email_unique ON users (lower(email)) WHERE "companyId" IS NULL`);
    await q(`CREATE UNIQUE INDEX users_company_email_unique ON users ("companyId", lower(email)) WHERE "companyId" IS NOT NULL`);
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX users_company_email_unique');
    await q('DROP INDEX users_super_admin_email_unique');
    await q('CREATE UNIQUE INDEX users_email_unique ON users (lower(email))');
    await q('ALTER TABLE users DROP CONSTRAINT users_company_fk');
    await queryInterface.dropTable('company_services');
    await queryInterface.dropTable('companies');
    await queryInterface.dropTable('services');
  },
};
