// A company (or user) that has a PROCESS service must also have every active FOLDING and PACKING service: a process hands its fabric on to them. Switching a process off is not coupled.
const { Service } = require('../models');

/** The active FOLDING and PACKING services, when `services` has a PROCESS one; else []. */
async function extrasFor(services, transaction) {
  if (!services.some((s) => s.kind === 'PROCESS')) return [];
  return Service.findAll({ where: { kind: ['FOLDING', 'PACKING'], isActive: true }, order: [['sortOrder', 'ASC']], transaction });
}

/** `services` plus the folding / packing ones they need (no duplicates). */
async function withBundle(services, transaction) {
  const have = new Set(services.map((s) => s.id));
  return [...services, ...(await extrasFor(services, transaction)).filter((s) => !have.has(s.id))];
}

module.exports = { extrasFor, withBundle };
