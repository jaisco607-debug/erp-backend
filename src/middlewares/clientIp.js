// The real address of the person calling. Production runs browser -> Cloudflare -> nginx -> web -> API, so req.ip is a proxy.
// With TRUST_CLIENT_IP_HEADER=true (origin reachable through Cloudflare only) CF-Connecting-IP, else the first X-Forwarded-For address, is used;
// otherwise a caller could invent an address, so req.ip stays.
const net = require('net');
const env = require('../config/env');

const one = (v) => (Array.isArray(v) ? v[0] : v);

function clientIp(req, trust = env.trustClientIpHeader) {
  if (trust) {
    const cf = String(one(req.headers['cf-connecting-ip']) || '').trim();
    if (net.isIP(cf)) return cf;
    const xff = String(one(req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    if (net.isIP(xff)) return xff;
  }
  return req.ip;
}

function middleware(req, res, next) {
  const ip = clientIp(req);
  if (ip !== req.ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  next();
}

module.exports = { clientIp, middleware };
