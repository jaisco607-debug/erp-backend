'use strict';
// Weaving > Yarn Inward (owner 2026-12-02): what the yarn is FOR. Every yarn inward entry says WEFT (for weft), WARP (for warp) or BOTH.
//   yarn_inwards.purpose   'WEFT' | 'WARP' | 'BOTH'; entries made before this change are BOTH (they were not split)
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE yarn_inwards ADD COLUMN purpose varchar(4) NOT NULL DEFAULT 'BOTH' CHECK (purpose IN ('WEFT', 'WARP', 'BOTH'))`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE yarn_inwards DROP COLUMN purpose');
  },
};
