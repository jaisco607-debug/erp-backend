# Step 1: Setup (JavaScript)

Is step men koi business module nahi. Sirf woh bunyaad he jis par saare modules chalenge.

Is ke baad server chalta he aur `GET /api/health` par `{"status":"ok"}` deta he.

## Ek request ka safar

```
Browser / frontend
   │
   ▼
app.js
  1. requestLogger   har request ko id, aur ek log line
  2. helmet          security headers
  3. cors            sirf aapka frontend
  4. express.json    JSON parhna (1 MB tak)
  5. rateLimit       ek IP se 300 requests / minute
  6. routes          /api/health, aage /api/v1/...
  7. notFound        ghalat URL
  8. errorHandler    har error ek hi shakal men
```

Aage modules men har route ke andar yeh safar aur lamba hoga:
**route → middleware (login, ijazat, data jaanch) → controller → service → model → database**

## Libraries (package.json)

| Library | Kaam |
|---|---|
| express | web server |
| sequelize + pg | PostgreSQL se baat, models aur migrations |
| helmet | browser security headers |
| express-rate-limit | ek IP se hadd se zyada requests rokna |
| joi | aane wale data aur `.env` settings ki jaanch |
| pino + pino-http | tez JSON logs (request logs) |
| bcryptjs | password hash (Step 2) |
| jsonwebtoken | login token (Step 2) |
| dotenv | `.env` file parhna |
| jest + supertest | tests (sirf development) |
| nodemon | code badlo to server khud restart (sirf development) |
| sequelize-cli | migrations chalane ki command |

`overrides.uuid`: Sequelize ki andar wali `uuid` library ka purana version security report men aata tha, is liye naya version zabardasti lagaya. Ab `npm audit` men 0 masle hen.

## Commands

| Command | Kya karti he |
|---|---|
| `npm run dev` | development men chalana (badlao par khud restart) |
| `npm start` | production men chalana |
| `npm run db:migrate` | database men tables banana (Step 2 se) |
| `npm run db:migrate:undo` | aakhri migration wapas |
| `npm test` | saare tests |

## Har file ka matlab

### `.env.example` → `.env`
Saari khufia settings yahan, code men nahi:
- database address aur password
- JWT secrets
- port
- frontend ka address
- log level

`.env.example` sirf namoona he. Aap usay copy kar ke `.env` banate hen aur apni values daalte hen. `.gitignore` men `.env` likha he, is liye password kabhi code ke sath kahin nahi jata.

### `.sequelizerc`
Migration tool (`sequelize-cli`) ko batata he ke models, migrations aur config kis folder men hen.

### `src/config/env.js`
`.env` parhta he aur **Joi** se har setting check karta he:
- `DATABASE_URL` sahi postgres address he?
- `PORT` sahi number he?
- **Production men** JWT secret kam az kam 32 characters ka he, aur namoone wala `change-me` to nahi?

Koi setting ghalat ho to server shuru hi nahi hota. Error men sirf setting ka **naam** aata he, value (password) kabhi print nahi hoti.

Baaki saari files settings isi file se leti hen, `process.env` ko seedha nahi chhooti.

### `src/config/database.js`
PostgreSQL se ek **pool** connection banata he (10 connections tak, jo baar baar istemal hote hen).
- `logging: false`: SQL queries log men nahi aati (in men customers ka data hota he).
- `DATABASE_SSL=true`: cloud database ke liye encrypted connection, certificate check ke sath.
- `connectDatabase()`: server shuru hone se pehle check karta he ke database jawab de raha he.

### `src/config/ssl.js`
Cloud database (jese Supabase) se **encrypted** connection. `DATABASE_SSL=true` ho to:
- connection SSL par hota he, raste men koi data parh nahi sakta
- database ka certificate hamesha check hota he, taake koi beech men naqli database ban kar password na le sake
- Supabase jese provider apna certificate file (`.crt`) dete hen; us ka rasta `DATABASE_SSL_CA` men likha jata he

### `src/config/sequelize-cli.js`
Migration command ke liye wahi database settings. Migrations ka record `sequelize_migrations` table men rehta he, is liye har migration sirf ek dafa chalti he.

### `src/utils/logger.js`
Poore app ka ek logger (pino), JSON lines likhta he jo koi bhi log system parh sakta he.

**redact**: password, token, refreshToken, authorization header jese fields log men likhne se pehle `[REDACTED]` ban jati hen. Galti se bhi password log men nahi jayega.

### `src/utils/AppError.js`
Jaan boojh kar bheje jane wale errors. Har ek ka HTTP code aur ek pakka `code` jis par frontend faisla kar sake:

| Function | HTTP | Kab |
|---|---|---|
| `AppError.validation()` | 400 | data ghalat shakal men |
| `AppError.unauthorized()` | 401 | login nahi ya token kharab |
| `AppError.forbidden()` | 403 | login he magar ijazat nahi |
| `AppError.notFound()` | 404 | record nahi mila, ya kisi aur company ka he |
| `AppError.rule()` | 422 | kaarobari qaida toota (lot men itne meter nahi) |

### `src/middlewares/requestLogger.js`
**Request log.** Har request ko ek id milti he. Agar hamara apna proxy `X-Request-Id` bheje aur woh mehfooz shakal men ho to wahi rakhi jati he, warna nayi banti he.

Request khatam hone par ek line likhi jati he:
- method aur URL (query ki values ke baghair)
- status
- kitne millisecond lage
- IP
- login ke baad user id aur company id

Body kabhi log nahi hoti. Kamyab request `info` level par, 400 wale `warn` par, 500 wale `error` par.

### `src/middlewares/cors.js`
Browser ko batata he kon si website API call kar sakti he: sirf `CORS_ORIGINS` wale addresses.
- Development men list khali ho to sab allowed (asaani ke liye).
- **Production men khali list = koi website allowed nahi.**

### `src/middlewares/notFound.js`
Jo URL kisi route ne nahi pakra, us par 404.

### `src/middlewares/errorHandler.js`
Har error ki aakhri manzil. User ko hamesha `{ "error": { "code", "message", "details" } }` milta he.

| Error | Jawab |
|---|---|
| AppError | jo humne khud bataya |
| toota JSON | 400 `BAD_JSON` |
| 1 MB se bari body | 413 |
| same value dobara (jaise email) | 409 `DUPLICATE` |
| linked record delete | 409 `IN_USE` |
| stock / balance ka database qaida | 422 `CONSTRAINT` |
| **koi bhi aur (bug)** | poori detail **sirf log men**; user ko sirf `INTERNAL_ERROR` + `requestId` |

Is tarah database ya code ki andar ki baat kabhi bahar nahi jati. Masla ho to user ki request id se log men poori kahani mil jati he.

### `src/routes/index.js`
Saare routes ki fehrist. Abhi sirf `/api/health`: database jawab de to `ok`, na de to 503 (monitoring ko pata chal jata he).

Har naya module yahan apni line jorega, maslan `router.use('/v1/auth', require('./auth.routes'))`.

### `src/app.js`
Upar wala "request ka safar" isi file men tarteeb se likha he.

`trust proxy 1` ka matlab: production men aage ek nginx / load balancer hoga, us ka bataya hua asal IP mana jaye. Is ke baghair sab requests ek hi IP ki lagengi aur rate limit ghalat chalega.

### `src/server.js`
Program yahan se shuru hota he:
1. database se connect
2. port par sunna

Band karte waqt (`SIGTERM`, jese server restart): naye requests band, chalti requests mukammal, phir database band. 10 second men na ho to zabardasti band.

### Khali folders (agle steps ke liye)
| Folder | Kya aayega |
|---|---|
| `src/models/` | har table ka model |
| `src/controllers/` | request lena, service ko dena, jawab bhejna |
| `src/services/` | asal kaarobari kaam, transaction, audit log |
| `src/validators/` | Joi se har request ke data ki jaanch |
| `migrations/` | tables banane / badalne wali files |
| `seeders/` | shuru ka data (Textile industry, departments ki list) |

### `tests/setup.js` aur `tests/app.test.js`
Tests alag database `erp_test` par chalte hen, asal data ko kabhi nahi chhoote. Is step ke 6 tests:
- health `ok` deta he aur har jawab par request id he
- security headers aa rahe hen; `x-powered-by` (Express ka naam) chhupa he
- ghalat URL aur toota JSON sahi error shakal men
- 1 MB se bari body rad
- proxy ki mehfooz request id rakhi, kharab (`<script>`) badli
- allowed frontend ko CORS ijazat

## Chalane ka tareeqa
```bash
cp .env.example .env      # apna DATABASE_URL daalen
npm install
npm run dev               # http://localhost:3000/api/health
```
