// Passwords are never stored. Only a bcrypt hash is kept: slow on purpose (12 rounds),
// so even a stolen database copy takes years to crack.
const bcrypt = require('bcryptjs');

const ROUNDS = 12;

// Compared against when the email does not exist, so a wrong email takes as long as a wrong password
// and nobody can find out which emails are registered by timing the answer.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
const checkPassword = (plain, hash) => bcrypt.compare(plain, hash || DUMMY_HASH);

module.exports = { hashPassword, checkPassword };
