// Two kinds of login token:
//   access token   short life (15 min), sent with every request in the Authorization header
//   refresh token  long life (7 days), only used to get a new access token; stored in the database as a hash
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const ms = require('ms');
const env = require('../config/env');

const ISSUER = 'textile-erp';
const AUDIENCE = 'textile-erp-api';

// impersonator: a super admin who opened a company (the token is the client admin's, with the super admin's id inside)
function signAccessToken(user, { impersonator, ttl } = {}) {
  const claims = { typ: 'access', ver: user.tokenVersion };
  if (impersonator) { claims.imp = impersonator.id; claims.impVer = impersonator.tokenVersion; }
  return jwt.sign(claims, env.jwt.accessSecret, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ttl || env.jwt.accessTtl,
  });
}

/** Returns the token payload, or null for any bad, expired or tampered token. */
function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.jwt.accessSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    return payload.typ === 'access' ? payload : null;
  } catch {
    return null;
  }
}

/** A random refresh token (shown to the user once) and the hash we keep. */
function newRefreshToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + ms(env.jwt.refreshTtl)) };
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { signAccessToken, verifyAccessToken, newRefreshToken, hashToken };
