# Step 10: Client admin ke employees, aur super admin sirf dekhta he

## Kya he
- **Client admin apne employees banata he** (naam, email, password, phone) aur har employee ko company ki services me se alag alag ya sab de sakta he (View ya Full). Employee **company code + apni email + password** se login karta he aur use sirf wahi nazar aata he jo diya gaya.
- Client admin sirf employee bana sakta he, doosra client admin nahi. Client admin sirf wahi services de sakta he jo super admin ne company ko di hen. Report ki services hamesha sirf View.
- **Super admin sirf client admin banata he** (company register karte waqt, ya baad me `POST /companies/:id/admins`) aur usay disable, enable, delete kar sakta he. Employees ko wo na bana sakta he na badal sakta he. Wo sirf **dekh** sakta he: `GET /v1/admin/users` (kis client admin ke kaun se employees hen) aur `GET /v1/admin/users/:id` (un ke paas kaun si services hen).

## Client admin disable ya delete hone par
Employee tab tak kaam kar sakta he jab tak company on ho **aur** company ka kam az kam ek client admin active ho (na disable, na delete). Aakhri active client admin disable ya delete hote hi uske saare employees ka login, khule hue session aur refresh sab band ho jate hen. Employees delete nahi hote, bas access band hota he; client admin dobara enable ho to wapis chal parte hen. Do client admin hon aur ek disable ho to kuch nahi badalta.

## Files
- `migrations/20261020000004-user-phone-deleted.js`: `users.phone`, `users.deletedAt`, email ka unique index sirf delete na hue logon par.
- `src/services/companyAccessService.js`: "company ka active client admin he ya nahi" aur `effect`.
- `src/services/companyUserService.js`, `companyUserRoutes.js`: client admin ke employees.
- `src/services/companyService.js`: `createAdmin`, `deleteAdmin`, `updateAdmin` (+ `effect`).
- `src/services/adminUserService.js`, `src/routes/adminUserRoutes.js`: super admin ka sirf-dekhne wala view.
- `src/middlewares/authenticate.js`, `src/services/authService.js`: employee ke login / har call / refresh par wahi rule.
- `tests/employees.test.js`: employee banana, services dena, login, super admin ka view, disable / delete par lock-out.
- Frontend ke liye: `docs/frontend/employees.md`.
