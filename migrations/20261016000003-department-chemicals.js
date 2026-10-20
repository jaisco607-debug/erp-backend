// Which chemicals each department may see (and later request). Set by the Chemical Store.
// No row = the department sees nothing: a department sees no chemical until the store gives it.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE department_chemicals (
        id uuid PRIMARY KEY,
        "companyId" uuid NOT NULL REFERENCES companies(id),
        "departmentId" uuid NOT NULL REFERENCES services(id),
        "itemId" uuid NOT NULL REFERENCES store_items(id),
        "createdById" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("companyId", "departmentId", "itemId")
      );
      CREATE INDEX department_chemicals_item ON department_chemicals ("itemId");`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE department_chemicals');
  },
};
