// Step 3 routes. Company people only, and only with the Grey Store service:
//   VIEW access  lists and details
//   FULL access  add, edit, approve, active toggle
//   client admin additionally: take an approval back, set where numbering continues
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const requireAnyService = require('../middlewares/requireAnyService');
const COLOUR_DEPARTMENTS = require('../utils/colourDepartments');
const v = require('../validators/greyValidator');
const c = require('../controllers/greyController');

const grey = require('../services/greyReturnService');
const { Joi, paging } = require('../validators/common');
const { ymdDate } = require('../utils/dates');

const SERVICE = 'GREY_STORE';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');
const admin = requireUserType('CLIENT_ADMIN');

function masterRouter(rules, ctl) {
  const r = express.Router();
  r.use(authenticate);
  r.get('/', view, validate(rules.list), ctl.list);
  r.post('/', full, validate(rules.create), ctl.create);
  r.get('/:id', view, validate(rules.get), ctl.get);
  r.patch('/:id', full, validate(rules.update), ctl.update);
  r.delete('/:id', full, validate(rules.get), ctl.remove);
  return r;
}

const customers = masterRouter(v.customer, c.customer);

const lots = express.Router();
lots.use(authenticate);
lots.get('/numbering', view, c.lot.nextNumbers);
lots.put('/numbering', admin, full, validate(v.lot.numbering), c.lot.setNextNumbers);
// fabric return grey: everything the Grey Store screen needs, with the GREY_STORE service only
// (list with packing list / gate pass, one entry, and the lot / thaan picker). Before '/:id' on purpose.
const ymd = ymdDate();
lots.get('/fabric-returns', view, validate({ query: Joi.object({ ...paging, search: Joi.string().trim().max(100), customerId: Joi.string().guid(), dateFrom: ymd, dateTo: ymd }) }),
  async (req, res) => res.json(await grey.list(req, req.validatedQuery)));
lots.get('/fabric-returns/:id', view, validate({ params: Joi.object({ id: Joi.string().guid().required() }) }),
  async (req, res) => res.json(await grey.get(req, req.params.id)));
lots.get('/fabric-return/lots', view, validate({ query: Joi.object({ customerId: Joi.string().guid(), search: Joi.string().trim().max(20), limit: Joi.number().integer().min(1).max(500).default(200) }) }),
  async (req, res) => res.json(await grey.availableLots(req, req.validatedQuery)));
lots.get('/', view, validate(v.lot.list), c.lot.list);
lots.post('/', full, validate(v.lot.create), c.lot.create);
lots.get('/:id', view, validate(v.lot.get), c.lot.get);
lots.patch('/:id', full, validate(v.lot.update), c.lot.update);
lots.delete('/:id', full, validate(v.lot.get), c.lot.remove);
lots.put('/:id/active', full, validate(v.lot.active), c.lot.setActive);
lots.post('/:id/approve', full, validate(v.lot.approve), c.lot.approve);
lots.post('/:id/unapprove', admin, full, validate(v.lot.approve), c.lot.unapprove);
// cloth given back to the party unprocessed
lots.post('/:id/give-back', full, validate(v.lot.giveBack), c.lot.giveBack);
lots.delete('/:id/give-back/:returnId', admin, full, validate(v.lot.undoGiveBack), c.lot.undoGiveBack);

// fabric return grey: unprocessed thaans go straight to Folding, then Packing (owner 2026-10-19)
const retLine = Joi.object({
  greyLotId: Joi.string().guid().required(),
  thaanNos: Joi.array().items(Joi.number().integer().min(1)).min(1).max(2000).unique(),
  thaans: Joi.array().items(Joi.object({ thaanNo: Joi.number().integer().min(1).required(), meters: Joi.number().precision(2).positive().max(99999999) })).min(1).max(2000).unique('thaanNo'),
  meters: Joi.number().precision(2).positive().max(99999999),
  pieces: Joi.number().integer().min(0).max(1000000).default(0),
}).xor('thaanNos', 'thaans', 'meters');
lots.post('/fabric-return', full, validate({ body: Joi.object({
  lots: Joi.array().items(retLine).min(1).max(50).unique('greyLotId').required(),
  cardDate: ymdDate(), sentThrough: Joi.string().trim().max(120).allow('', null), remarks: Joi.string().trim().max(500).allow('', null),
}) }), async (req, res) => res.status(201).json(await grey.fabricReturn(req, req.body)));

// Colours: kept by the SO card desk, picked from a dropdown when cloth is sent, and given to the cloth by Dyeing
// (only Dyeing gives colours). So the list and a new colour are open to the SO card desk AND to the colour
// department (Dyeing): a Dyeing employee needs only the Dyeing service. Changing or deleting a colour stays with the SO card desk.
const colourReaders = ['SO_CARD', ...COLOUR_DEPARTMENTS];
const colourView = requireAnyService(colourReaders, 'VIEW');
const colourAdd = requireAnyService(colourReaders, 'FULL');
const colourFull = requireService('SO_CARD', 'FULL');
const colours = express.Router();
colours.use(authenticate);
colours.get('/', colourView, validate(v.quality.list), c.colour.list);
colours.post('/', colourAdd, validate(v.quality.create), c.colour.create);
colours.get('/:id', colourView, validate(v.quality.get), c.colour.get);
colours.patch('/:id', colourFull, validate(v.quality.update), c.colour.update);
colours.delete('/:id', colourFull, validate(v.quality.get), c.colour.remove);

module.exports = {
  colours,
  customers,
  qualities: masterRouter(v.quality, c.quality),
  lots,
};
