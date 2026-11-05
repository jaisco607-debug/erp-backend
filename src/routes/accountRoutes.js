// /api/v1/accounts  -  Chart of Accounts (service ACC_COA). Company people only: VIEW reads, FULL adds / edits / deletes.
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireService = require('../middlewares/requireService');
const v = require('../validators/accountValidator');
const c = require('../controllers/accountController');
const defaults = require('../services/defaultAccountService');

const SERVICE = 'ACC_COA';
const view = requireService(SERVICE, 'VIEW');
const full = requireService(SERVICE, 'FULL');

const router = express.Router();
router.use(authenticate);
router.get('/options', view, c.options);
router.get('/tree', view, validate(v.tree), c.tree);
router.get('/next-code', view, validate(v.nextCode), c.nextCode);
router.get('/presets', view, c.presets);
router.get('/issues', view, c.issues);
router.get('/templates', view, c.templates);
router.post('/apply-template', full, validate(v.applyTemplate), c.applyTemplate);
// the default accounts (the tab "Default accounts"): before the "/:id" routes
router.get('/defaults', view, async (req, res) => res.json(await defaults.list(req)));
router.post('/defaults/create-all', full, async (req, res) => res.json(await defaults.createAll(req)));
router.get('/defaults/:key/candidates', view, validate(v.defaultKey), async (req, res) => res.json(await defaults.candidates(req, req.params.key)));
router.put('/defaults/:key', full, validate(v.defaultSet), async (req, res) => res.json(await defaults.set(req, req.params.key, req.body)));
router.post('/defaults/:key/create', full, validate(v.defaultKey), async (req, res) => res.json(await defaults.create(req, req.params.key)));
router.get('/', view, validate(v.list), c.list);
router.post('/', full, validate(v.create), c.create);
router.get('/:id', view, validate(v.get), c.get);
router.patch('/:id', full, validate(v.update), c.update);
router.delete('/:id', full, validate(v.get), c.remove);

module.exports = router;
