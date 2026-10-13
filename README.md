# Textile ERP Backend

Node.js + Express (JavaScript) + PostgreSQL (Sequelize). Built step by step; every step is explained in Roman Urdu in `docs/samjhao/`.

| Step | Kya bana | Samjhao |
|---|---|---|
| 1 | Setup: server, settings, security headers, CORS, rate limit, request logs, errors | [01-setup.md](docs/samjhao/01-setup.md) |
| 2a | Ek login sab ke liye, super admins, audit log | [02a-login-audit.md](docs/samjhao/02a-login-audit.md) |
| 2b | Companies, company code se login, services | [02b-companies-services.md](docs/samjhao/02b-companies-services.md) |
| 2c | Client admin apne users banaye, service ijazat (view / full) | [02c-company-users.md](docs/samjhao/02c-company-users.md) |
| 3 | Grey inward: customers, qualities, grey lots (lot no, re-process, active, approve) | docs/samjhao/03-grey-inward.md |
| 4 | SO card: lots se meter, department ko bhejna, accept, status | docs/samjhao/04-so-card.md |
| 5 | Departments (send, accept, process, reject) | aage |
| 6 | Chemical store + requests | aage |
| 7 | Folding, finished stock, packing list, gate pass | aage |

## APIs

- Front end ke liye: [docs/API.md](docs/API.md)
- Postman: `postman/textile-erp.postman_collection.json`
- Khud chala kar dekhna: [02a-api-chalana.md](docs/samjhao/02a-api-chalana.md)

## Chalane ka tareeqa

```bash
cp .env.example .env     # DATABASE_URL aur JWT secrets apne daalen
npm install
npm run db:migrate       # database tables banana / naye tables lana
npm run create:superadmin -- --name "Aapka Naam" --email aap@example.com   # pehla super admin
npm run superadmin:code  # super admins ka login code dikhata he
npm run dev              # http://localhost:3000/api/health
npm test                 # tests (erp_test database chahiye)
```
