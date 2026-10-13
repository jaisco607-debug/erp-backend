// Step 3 routes. Company people only, and only with the Grey Store service:
//   VIEW access  lists and details
//   FULL access  add, edit, approve, active toggle
//   client admin additionally: take an approval back, set where numbering continues
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const requireService = require('../middlewares/requireService');
const v = require('../validators/greyValidator');
const c = require('../controllers/greyController');

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
lots.get('/', view, validate(v.lot.list), c.lot.list);
lots.post('/', full, validate(v.lot.create), c.lot.create);
lots.get('/:id', view, validate(v.lot.get), c.lot.get);
lots.patch('/:id', full, validate(v.lot.update), c.lot.update);
lots.delete('/:id', full, validate(v.lot.get), c.lot.remove);
lots.put('/:id/active', full, validate(v.lot.active), c.lot.setActive);
lots.post('/:id/approve', full, validate(v.lot.approve), c.lot.approve);
lots.post('/:id/unapprove', admin, full, validate(v.lot.approve), c.lot.unapprove);

// Colours: kept by the SO card desk, picked from a dropdown when cloth is sent.
const colourView = requireService('SO_CARD', 'VIEW');
const colourFull = requireService('SO_CARD', 'FULL');
const colours = express.Router();
colours.use(authenticate);
colours.get('/', colourView, validate(v.quality.list), c.colour.list);
colours.post('/', colourFull, validate(v.quality.create), c.colour.create);
colours.get('/:id', colourView, validate(v.quality.get), c.colour.get);
colours.patch('/:id', colourFull, validate(v.quality.update), c.colour.update);
colours.delete('/:id', colourFull, validate(v.quality.get), c.colour.remove);

module.exports = {
  colours,
  customers,
  qualities: masterRouter(v.quality, c.quality),
  lots,
};
