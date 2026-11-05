const { Joi, uuidParam } = require('./common');
const { fields } = require('./payrollEmployeeValidator');
const { ymdDate } = require('../utils/dates');

const id = Joi.string().guid();
const date = ymdDate();
// the last day of a month filter: not before the first day
const dateTo = date.custom((v, h) => { const from = h.state.ancestors[0].from; return from && v < from ? h.error('date.order') : v; }).messages({ 'date.order': 'to must not be before from' });
// the joining application is the employee card's form: same fields (and the same rules), plus HR's remarks
const form = { ...fields, remarks: Joi.string().trim().max(500).allow('', null) };
const REVIEW = ['joiningDate', 'groupId', 'departmentId', 'designationId', 'shiftId', 'salaryType', 'basicSalary', 'foodAllowance', 'maintenanceAllowance', 'mobileAllowance', 'monthlyIncomeTax', 'remarks'];
const kind =Joi.string().valid('photo', 'cnic-front', 'cnic-back', 'form').required();

module.exports = {
  list: {
    query: Joi.object({
      page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(1000).default(100), search: Joi.string().trim().max(100),
      groupId: id, departmentId: id, designationId: id, status: Joi.string().valid('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED'),
      from: date, to: dateTo, // the day the application was made (Pakistan time), both included
    }),
  },
  get: { params: uuidParam },
  create: { body: Joi.object({ ...form, name: form.name.required(), groupId: form.groupId.required(), joiningDate: form.joiningDate.required() }) },
  update: { params: uuidParam, body: Joi.object(form).min(1) },
  // the reviewer corrects only the work and salary details
  review: { params: uuidParam, body: Joi.object(Object.fromEntries(REVIEW.map((k) => [k, form[k]]))).min(1) },
  reject: { params: uuidParam, body: Joi.object({ reason: Joi.string().trim().min(3).max(500).required() }) },
  approvers: { body: Joi.object({ userIds: Joi.array().items(id).max(100).required() }) },
  file: { params: Joi.object({ id: Joi.string().guid({ version: 'uuidv4' }).required(), kind }) },
};
