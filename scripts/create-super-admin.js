// Creates the FIRST super admin (after that, super admins add each other from the app).
//   npm run create:superadmin -- --name "Fahad Ayaz" --email fahad@example.com
// The password is asked on the screen and not shown while typing. It is never saved in a file.
const readline = require('readline');
const { sequelize } = require('../src/config/database');
const { newPassword, email: emailRule } = require('../src/validators/common');
const superAdminService = require('../src/services/superAdminService');
const { superAdminCode } = require('../src/services/loginCodeService');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
      else if (s !== '\r\n' && s !== '\n') rl.output.write('*');
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const name = arg('name');
  const { value: email, error: emailError } = emailRule.required().validate(arg('email'));
  if (!name || emailError) {
    console.error('Usage: npm run create:superadmin -- --name "Your Name" --email you@example.com');
    process.exitCode = 1;
    return;
  }

  const password = await askHidden('Password (10+ chars, capital, small, digit): ');
  const { error } = newPassword.required().validate(password);
  if (error) {
    console.error(`Password not accepted: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if ((await askHidden('Same password again: ')) !== password) {
    console.error('The two passwords do not match.');
    process.exitCode = 1;
    return;
  }

  // No HTTP request here: the audit row records this as done by SYSTEM from the command line.
  const fakeReq = { ip: 'command-line', headers: { 'user-agent': 'scripts/create-super-admin.js' }, user: null };
  const user = await superAdminService.create(fakeReq, { name, email, password });
  console.log(`Super admin created: ${user.email}`);
  console.log(`Login code for super admins: ${await superAdminCode()}`);
}

main()
  .catch((err) => {
    if (err.name === 'SequelizeUniqueConstraintError') console.error('A user with this email already exists.');
    else console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
