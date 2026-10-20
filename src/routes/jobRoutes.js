// /api/v1/jobs  -  cloth moving through departments (Step 5).
// Access is checked per department inside the service:
//   sending from the SO card desk  needs SO Card FULL
//   sending from a department      needs FULL on that department
//   changing a job's status        needs FULL on the receiving department
//   lists                          need at least VIEW on that department (or SO Card)
const express = require('express');
const validate = require('../middlewares/validate');
const authenticate = require('../middlewares/authenticate');
const requireUserType = require('../middlewares/requireUserType');
const v = require('../validators/jobValidator');
const c = require('../controllers/jobController');

const router = express.Router();
router.use(authenticate, requireUserType('CLIENT_ADMIN', 'USER'));

router.get('/form-data', validate(v.formData), c.formData);
router.get('/so-card/:id', validate(v.history), c.history);
router.get('/', validate(v.list), c.list);
router.post('/', validate(v.create), c.create);
router.get('/:id', validate(v.get), c.get);
router.patch('/:id', validate(v.update), c.update);
router.put('/:id/status', validate(v.status), c.setStatus);
router.put('/:id/operator', validate(v.operator), c.setOperator);

module.exports = router;
