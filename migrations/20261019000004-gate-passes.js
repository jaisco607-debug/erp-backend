// Gate pass (owner 2026-10-19): one per packing list. The cloth leaves the factory with it.
// Lots and thaan numbers come from the packing list; the form adds the driver, vehicle, date,
// destination and the packing operator. The frontend prints 3 copies (Packing, Guard, Driver).
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE gate_passes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "gatePassNo" integer NOT NULL,
        "packingListId" uuid NOT NULL UNIQUE REFERENCES packing_lists(id) ON DELETE CASCADE,
        "passDate" date NOT NULL,
        "operatorName" varchar(120),
        "driverName" varchar(120),
        "vehicleNo" varchar(40),
        destination varchar(200),
        remarks varchar(300),
        "createdById" uuid REFERENCES users(id),
        "updatedById" uuid REFERENCES users(id),
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "gatePassNo")
      );
    `);
  },
  async down(queryInterface) { await queryInterface.sequelize.query('DROP TABLE gate_passes;'); },
};
