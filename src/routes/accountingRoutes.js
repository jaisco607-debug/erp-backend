// /api/v1/accounting  -  opening balances and accounting settings (service ACC_COA). VIEW reads, FULL changes.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/accountingValidator');
const opening = require('../services/openingBalanceService');
const reports = require('../services/trialBalanceService');
const parties = require('../services/partyLedgerService');
const bank = require('../services/bankSummaryService');
const statements = require('../services/financialStatementService');
const partyReports = require('../services/partyReportService');
const dueSchedule = require('../services/dueScheduleService');

const SERVICE = 'ACC_COA';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');
const viewReports = requireService('ACC_REPORTS', 'VIEW');
const viewBank = requireService('ACC_BANK', 'VIEW');
const fullBank = requireService('ACC_BANK', 'FULL');

const router = express.Router();
router.use(authenticate);
// the Accounting Overview in one call: every block is filtered by the person's own services (a block they may not see is null, never 403)
router.get('/overview', async (req, res) => res.json(await require('../services/accountingOverviewService').overview(req)));
router.get('/opening-balances', view, validate(v.openingGet), async (req, res) => res.json(await opening.get(req, req.validatedQuery)));
router.put('/opening-balances', full, validate(v.openingSave), async (req, res) => res.json(await opening.save(req, req.body)));
// reports (service ACC_REPORTS, read only)
router.get('/trial-balance', viewReports, validate(v.trialBalance), async (req, res) => res.json(await reports.trialBalance(req, req.validatedQuery)));
router.get('/ledger', viewReports, validate(v.ledger), async (req, res) => res.json(await reports.ledger(req, req.validatedQuery)));
router.get('/party-ledger', viewReports, validate(v.partyLedger), async (req, res) => res.json(await parties.partyLedger(req, req.validatedQuery)));
router.get('/payables', viewReports, validate(v.parties), async (req, res) => res.json(await parties.payables(req, req.validatedQuery)));
router.get('/receivables', viewReports, validate(v.parties), async (req, res) => res.json(await parties.receivables(req, req.validatedQuery)));
router.get('/profit-loss', viewReports, validate(v.profitLoss), async (req, res) => res.json(await statements.profitLoss(req, req.validatedQuery)));
router.get('/balance-sheet', viewReports, validate(v.balanceSheet), async (req, res) => res.json(await statements.balanceSheet(req, req.validatedQuery)));
router.get('/balances', viewReports, validate(v.balances), async (req, res) => res.json(await partyReports.balances(req, req.validatedQuery)));
router.get('/balances/open-items', viewReports, validate(v.openItems), async (req, res) => res.json(await partyReports.partyOpenItems(req, req.validatedQuery)));
router.get('/due-schedule', viewReports, validate(v.dueSchedule), async (req, res) => res.json(await dueSchedule.dueSchedule(req, req.validatedQuery)));
router.get('/cutoff', viewReports, validate(v.cutoff), async (req, res) => res.json(await partyReports.cutoff(req, req.validatedQuery)));
// bank summary (service ACC_BANK)
router.get('/bank-accounts', viewBank, async (req, res) => res.json({ data: await bank.accounts(req) }));
router.get('/bank-summary', viewBank, validate(v.bankSummary), async (req, res) => res.json(await bank.summary(req, req.validatedQuery)));
router.put('/bank-clearing', fullBank, validate(v.bankClearingSet), async (req, res) => res.json(await bank.setCleared(req, req.body)));
router.delete('/bank-clearing/:lineId', fullBank, validate(v.bankClearingRemove), async (req, res) => { await bank.removeCleared(req, req.params.lineId); res.status(204).end(); });
router.get('/settings', view, async (req, res) => res.json(await opening.getSettings(req)));
router.put('/settings', full, validate(v.settingsSave), async (req, res) => res.json(await opening.saveSettings(req, req.body)));

module.exports = router;
