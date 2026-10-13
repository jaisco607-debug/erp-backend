// Shows the login code all super admins type on the login screen.
//   npm run superadmin:code
const { sequelize } = require('../src/config/database');
const { superAdminCode } = require('../src/services/loginCodeService');

superAdminCode()
  .then((code) => console.log(code ? `Super admin login code: ${code}` : 'No code yet: run "npm run db:migrate" first.'))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
