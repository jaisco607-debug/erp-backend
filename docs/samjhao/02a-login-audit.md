# Step 2a: Ek login window, super admin aur audit log

Is step men 3 cheezen bani hen:
1. **Ek hi login** sab ke liye: super admin, client admin, users. Login ka jawab batata he ke yeh kon he (`userType`), frontend usi hisaab se screen dikhata he.
2. **Super admins** ka intezaam: naya banana, naam badalna, band karna, password reset.
3. **Audit log**: har login, ghalat password, logout, password change, super admin ki har tabdeeli likhi jati he. Yeh log **badla ya mitaya nahi ja sakta**, database khud mana karta he.

---

## Database (migration)

### `migrations/20261010000001-create-users-audit-sessions.js`
Database men 3 table banata he:

| Table | Kaam |
|---|---|
| `users` | Har woh shakhs jo login karta he. `userType` = SUPER_ADMIN / CLIENT_ADMIN / USER. Super admin ki koi company nahi hoti, baqi sab ki company hoti he (database CHECK yeh zabardasti karwata he). Email chhote bare harf se farq nahi parta (`lower(email)` unique). |
| `refresh_tokens` | Har login ka ek "session". Token khud nahi, sirf uska **hash** rakha jata he, taake database chori ho jaye to bhi tokens kaam na aayen. |
| `audit_logs` | Kisne, kab, kya kiya, kis IP aur browser se, pehle kya tha aur baad men kya hua. Ek **trigger** UPDATE, DELETE aur TRUNCATE ko rok deta he: "audit_logs is append-only". |

`users` men security wale columns:
- `passwordHash`: password nahi, uska bcrypt hash.
- `failedLoginCount`, `lockedUntil`: 5 ghalat password par account 15 minute ke liye band.
- `tokenVersion`: yeh number barhane se us user ke saare purane login foran khatam ho jate hen.

## Models (`src/models/`)
- `User.js`: users table ka JavaScript roop. `toSafeJSON()` sirf woh fields deta he jo API dikha sakti he (password hash kabhi nahi). `isLocked()` batata he account abhi band he ya nahi.
- `RefreshToken.js`, `AuditLog.js`: baqi do tables ke models.
- `index.js`: teeno models ko database se jorta he aur rishta batata he (ek user ke kai sessions).

## Utils (`src/utils/`)
- `password.js`: password ka bcrypt hash banata aur check karta he (12 rounds, jaan boojh kar slow). Agar email mojood hi na ho to bhi ek nakli hash se check karta he, taake jawab ka waqt yeh na bata de ke email registered he ya nahi.
- `tokens.js`: do tarah ke token:
  - **access token** (15 minute): har request ke saath `Authorization: Bearer ...` header men jata he.
  - **refresh token** (7 din): sirf naya access token lene ke liye. Har dafa use hone par naya milta he aur purana band ho jata he.

## Services (`src/services/`): asal qaide yahan hen
- `auditService.js`: audit row likhta he, **usi transaction men** jis men asal kaam hua. Kaam save hua to log bhi save, kaam fail hua to log bhi nahi. Password, hash aur tokens khud nikal deta he, kabhi log men nahi jate.
- `authService.js`:
  - `login`: ghalat email, ghalat password, band account, sab ka **ek hi jawab** ("Email or password is incorrect"), taake koi andaza na laga sake. 5 ghalat koshishon par 15 minute lock. Har koshish audit men.
  - `refresh`: purana refresh token de kar naya joda. Agar koi **pehle se istemal shuda** token dobara aaye to iska matlab kisi ne token copy kiya he: us user ke **saare** sessions khatam aur audit men `SESSION_REUSE_DETECTED`.
  - `logout`, `logoutAll` (sab devices se), `changePassword` (purane sab login khatam).
- `superAdminService.js`: super admin list/banana/badalna/band karna/password reset. Koi apne aap ko band nahi kar sakta. Band karte hi uske saare login foran khatam.
- `auditQueryService.js`: audit log parhna (filter: action, kisne, kis record par, tareekh se/tak).

## Middlewares (`src/middlewares/`)
- `validate.js`: aane wale data ki shakal check karta he (Joi). **Faltu field mana**: koi login form men `"userType":"SUPER_ADMIN"` daal kar chalaki nahi kar sakta.
- `authenticate.js`: token check karta he, user database se laata he. User band ho ya uska `tokenVersion` badal chuka ho to foran 401.
- `requireUserType.js`: sirf diye gaye qism ke user ko aage jane deta he, maslan `requireUserType('SUPER_ADMIN')`.
- `loginLimiter.js`: ek IP se 15 minute men sirf 10 login koshishen.

## Validators (`src/validators/`)
- `common.js`: mushtarka qaide. Naya password: kam se kam 10 harf, ek capital, ek small, ek number.
- `authValidator.js`, `superAdminValidator.js`, `auditValidator.js`: har route ka form.

## Controllers (`src/controllers/`)
Sirf HTTP request ko service tak le jate hen aur jawab wapas bhejte hen. Koi qaida yahan nahi.

## Routes (`src/routes/`)
| Method | URL | Kon | Kaam |
|---|---|---|---|
| POST | `/api/v1/auth/login` | sab | login (email + password) |
| POST | `/api/v1/auth/refresh` | sab | naya access token |
| POST | `/api/v1/auth/logout` | sab | is device se logout |
| POST | `/api/v1/auth/logout-all` | login wala | sab devices se logout |
| GET | `/api/v1/auth/me` | login wala | main kon hun |
| POST | `/api/v1/auth/change-password` | login wala | apna password badalna |
| GET/POST | `/api/v1/super-admins` | super admin | list / naya |
| PATCH | `/api/v1/super-admins/:id` | super admin | naam badalna, band/chalu karna |
| POST | `/api/v1/super-admins/:id/reset-password` | super admin | password reset |
| GET | `/api/v1/audit-logs` | super admin | audit log dekhna |

## Script
- `scripts/create-super-admin.js`: **pehla** super admin banane ke liye. Password screen par poochta he aur type karte waqt `*` dikhata he. Password kisi file men save nahi hota.

## Tests (`tests/`)
- `globalSetup.js`: test se pehle **sirf `_test` naam wala** database khaali kar ke migrations dobara chalata he. Asli database ko haath nahi lagata.
- `auth.test.js`, `superAdmin.test.js`: 18 naye tests, maslan: teeno qism ke user ek hi URL se login, lock, chori shuda refresh token, password audit men na jana, audit row na badal sakna.
