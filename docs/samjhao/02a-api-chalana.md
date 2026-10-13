# Step 2a ki APIs khud chala kar dekhna

## 1. Database men tables banana (sirf ek dafa, ya jab naya step aaye)
VS Code ka terminal (Ctrl + `) kholen, project folder men:
```
npm install
npm run db:migrate
```
Aakhir men `== 20261010000001-create-users-audit-sessions: migrated` aaye to tables ban gaye.
Supabase men **Table Editor** kholen: `users`, `refresh_tokens`, `audit_logs` nazar aayenge.

## 2. Pehla super admin banana
```
npm run create:superadmin -- --name "Fahad Ayaz" --email aapki@email.com
```
Password do dafa poochega (screen par `*` aayenge). Aakhir men **super admins ka login code** dikhata he (maslan `R4TW-9KXE`). Login men yeh code + email + password lagenge. Code baad men dobara dekhna ho to: `npm run superadmin:code`.

## 3. Server chalana
```
npm run dev
```
Browser men `http://localhost:3000/api/health` -> `{"status":"ok"}`.

## 4. Postman se har API chalana
1. Postman install karen (postman.com/downloads), kholen.
2. **Import** -> file chunen: `postman\textile-erp.postman_collection.json`.
3. Baen taraf **Textile ERP API** aa jayega. Usko click -> **Variables** tab: `baseUrl` = `http://localhost:3000/api` (pehle se he).
4. Is tarteeb se chalayen (har ek par **Send**):

| # | Request | Kya karna he | Kya aana chahiye |
|---|---|---|---|
| 1 | Health check | sirf Send | `{"status":"ok"}` |
| 2 | Auth -> Login | Body men apna email/password likhen | 200, `accessToken` aur `user`. Token khud save ho jata he |
| 3 | Auth -> Me | sirf Send | aapka user |
| 4 | Super admins -> Create | naam/email/password badal len | 201, naya super admin. Uski id khud save |
| 5 | Super admins -> List | Send | sab super admins |
| 6 | Super admins -> Update | `isActive: false` kar ke dekhen | woh band; uska login nahi chalega |
| 7 | Super admins -> Reset password | naya password | 204 (khaali jawab = kaam ho gaya) |
| 8 | Audit log -> List | Send | upar ke sab kaam yahan likhe nazar aayenge |
| 9 | Auth -> Refresh token | Send | naya token joda |
| 10 | Auth -> Change password | apna purana aur naya password | 204, phir dobara Login karna hoga |
| 11 | Auth -> Logout | Send | 204 |

Ghalti dekhne ke liye bhi try karen:
- Login men ghalat password 5 dafa -> account 15 minute ke liye band (sahi password bhi nahi chalega). Audit log men `LOGIN_FAILED` aayega.
- Login men koi faltu field daal den (`"userType": "SUPER_ADMIN"`) -> 400.
- Token ke baghair Me -> 401.

Access token 15 minute chalta he. 401 aaye to **Refresh token** chalayen ya dobara Login.

## 5. Front end wale ko kya dena he
- `docs/API.md`: har API, kya bhejna he, kya wapas aata he, errors ka format, login/refresh ka tareeqa.
- `postman/textile-erp.postman_collection.json`: woh bhi Import kar ke chala sakta he.
- Uska front end jis address par chalta he (maslan `http://localhost:5173`) woh aapki `.env` men `CORS_ORIGINS` men hona chahiye, warna browser request rok dega. Do address hon to comma se: `CORS_ORIGINS=http://localhost:5173,http://localhost:3001`. `.env` badal kar server restart karen.
- Agar front end doosre computer par he to `localhost` ki jagah aapke computer ka IP (maslan `http://192.168.1.10:3000/api`), aur Windows Firewall men port 3000 allow karna hoga.
