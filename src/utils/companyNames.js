// The name a company sees for a process it renamed (company_services.displayName). Loaded once per request by `authenticate`
// into an AsyncLocalStorage store; the Service model's `name` getter reads it, so every Sequelize read of a service shows the company's name.
// (Raw SQL reports use the SQL function svc_name(service, company, name).)
const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();
const current = () => store.getStore();
/** Remember this company's names for the rest of the request. */
const enter = (companyId, names) => store.enterWith({ companyId, names });
const nameOf = (serviceId, original) => {
  const s = store.getStore();
  return (s && s.names.get(serviceId)) || original;
};

/** After a rename inside the same request: show the new name at once (null = back to the original). */
const set = (serviceId, displayName) => {
  const s = store.getStore();
  if (!s) return;
  if (displayName) s.names.set(serviceId, displayName); else s.names.delete(serviceId);
};

module.exports = { enter, nameOf, current, set };
