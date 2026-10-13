// Company login codes. The server makes them at random, e.g. "K7QM-4XPA", so nobody can guess one from the company name.
// Letters that look alike (0/O, 1/I/L) are left out so the code is easy to read out and type.
// 31 letters/digits in 8 places = about 850 billion possible codes.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PATTERN = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

function generate() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What people type -> stored form: "k7qm 4xpa", "K7QM4XPA" and "k7qm-4xpa" all become "K7QM-4XPA". */
function normalize(input) {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

module.exports = { ALPHABET, PATTERN, generate, normalize };
