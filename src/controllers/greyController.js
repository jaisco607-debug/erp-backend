const masterService = require('../services/masterService');
const greyLotService = require('../services/greyLotService');

const masterController = (kind) => ({
  list: async (req, res) => res.json(await masterService.list(kind, req, req.validatedQuery)),
  get: async (req, res) => res.json(await masterService.get(kind, req, req.params.id)),
  create: async (req, res) => res.status(201).json(await masterService.create(kind, req, req.body)),
  update: async (req, res) => res.json(await masterService.update(kind, req, req.params.id, req.body)),
  remove: async (req, res) => {
    await masterService.remove(kind, req, req.params.id);
    res.status(204).end();
  },
});

exports.customer = masterController('customer');
exports.quality = masterController('quality');
exports.colour = masterController('colour');

exports.lot = {
  list: async (req, res) => res.json(await greyLotService.list(req, req.validatedQuery)),
  get: async (req, res) => res.json(await greyLotService.get(req, req.params.id)),
  create: async (req, res) => res.status(201).json(await greyLotService.create(req, req.body)),
  update: async (req, res) => res.json(await greyLotService.update(req, req.params.id, req.body)),
  remove: async (req, res) => {
    await greyLotService.remove(req, req.params.id);
    res.status(204).end();
  },
  setActive: async (req, res) => res.json(await greyLotService.setActive(req, req.params.id, req.body.isActive)),
  approve: async (req, res) => res.json(await greyLotService.setApproved(req, req.params.id, true)),
  unapprove: async (req, res) => res.json(await greyLotService.setApproved(req, req.params.id, false)),
  giveBack: async (req, res) => res.json(await greyLotService.giveBack(req, req.params.id, req.body)),
  undoGiveBack: async (req, res) => res.json(await greyLotService.undoGiveBack(req, req.params.id, req.params.returnId)),
  nextNumbers: async (req, res) => res.json(await greyLotService.nextNumbers(req)),
  setNextNumbers: async (req, res) => res.json(await greyLotService.setNextNumbers(req, req.body)),
};
