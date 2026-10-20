// Fabric return grey (owner 2026-10-19). A party sent e.g. 50 thaan, then wants 20 back unprocessed.
// The Grey Store picks those thaans and they go straight to Folding on a special SO card
// (isGreyReturn). Folding can only pass them to Packing (no grading, no departments); Packing makes
// the packing list and the gate pass. The tag "Fabric return grey" shows on every screen.
const { sequelize, Service } = require('../models');
const AppError = require('../utils/AppError');
const { companyServices } = require('./accessService');
const soCards = require('./soCardService');

/** lots: [{ greyLotId, thaanNos | thaans [{ thaanNo, meters }] | meters }], same lines as an SO card. */
async function fabricReturn(req, { lots, cardDate, sentThrough, remarks }) {
  const folding = (await companyServices(req.user.companyId)).find((s) => s.kind === 'FOLDING');
  if (!folding) throw AppError.rule('NO_FOLDING', 'Your company does not have the Folding department');
  return soCards.create(req, {
    lots, cardDate: cardDate || new Date().toISOString().slice(0, 10), departmentId: folding.id, sentThrough,
    remarks: remarks || 'Fabric return grey', description: 'FABRIC RETURN GREY', isGreyReturn: true,
  });
}

module.exports = { fabricReturn };
