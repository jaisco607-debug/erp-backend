const masters = require('../services/storeMasterService');
const inwards = require('../services/storeInwardService');

// req.store is CHEMICAL or GENERAL (set by the store routes); vendors are shared and ignore it.
const master = (kind) => ({
  list: async (req, res) => res.json(await masters.list(kind, req, req.store, req.validatedQuery)),
  get: async (req, res) => res.json(await masters.get(kind, req, req.store, req.params.id)),
  create: async (req, res) => res.status(201).json(await masters.create(kind, req, req.store, req.body)),
  update: async (req, res) => res.json(await masters.update(kind, req, req.store, req.params.id, req.body)),
  remove: async (req, res) => {
    await masters.remove(kind, req, req.store, req.params.id);
    res.status(204).end();
  },
});

exports.vendor = master('vendor');
exports.category = master('category');
exports.brand = master('brand');
exports.item = master('item');

exports.inward = {
  formData: async (req, res) => res.json(await inwards.formData(req, req.store)),
  list: async (req, res) => res.json(await inwards.list(req, req.store, req.validatedQuery)),
  get: async (req, res) => res.json(await inwards.get(req, req.store, req.params.id)),
  create: async (req, res) => res.status(201).json(await inwards.create(req, req.store, req.body)),
  update: async (req, res) => res.json(await inwards.update(req, req.store, req.params.id, req.body)),
  remove: async (req, res) => {
    await inwards.remove(req, req.store, req.params.id);
    res.status(204).end();
  },
  approve: async (req, res) => res.json(await inwards.approve(req, req.store, req.params.id)),
  unapprove: async (req, res) => res.json(await inwards.unapprove(req, req.store, req.params.id)),
};

exports.stock = async (req, res) => res.json(await inwards.stock(req, req.store, req.validatedQuery));
exports.itemStock = async (req, res) => res.json(await inwards.itemStock(req, req.store, req.params.id));
exports.itemMoves = async (req, res) => res.json(await inwards.itemMoves(req, req.store, req.params.id, req.validatedQuery));
