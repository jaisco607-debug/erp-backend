// Controllers only translate HTTP <-> service calls. The rules live in the services.
const authService = require('../services/authService');
const { profile } = require('../services/accessService');

exports.login = async (req, res) => {
  res.json(await authService.login(req, req.body));
};

exports.refresh = async (req, res) => {
  res.json(await authService.refresh(req, req.body.refreshToken));
};

exports.logout = async (req, res) => {
  await authService.logout(req, req.body.refreshToken);
  res.status(204).end();
};

exports.logoutAll = async (req, res) => {
  await authService.logoutAll(req);
  res.status(204).end();
};

exports.me = async (req, res) => {
  res.json(await profile(req.user));
};

exports.changePassword = async (req, res) => {
  await authService.changePassword(req, req.body);
  res.status(204).end();
};
