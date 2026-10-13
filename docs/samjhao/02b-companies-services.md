# Step 2b: Companies, company code se login, services

## Kya bana
1. **Super admin company register karta he.** Usi waqt:
   - company ka **code** server khud random banata he, maslan `K7QM-4XPA` (dekhen neeche "Random company code").
   - company ka **pehla client admin** banta he (naam, email, password).
   Dono kaam ek saath hote hen: ek fail ho to kuch save nahi hota.
   Registration par **koi service nahi** di jati. Services baad men do tareeqon se di jati hen:
   - **Company ki taraf se:** company kholo, us ki services chuno (`PUT /api/v1/companies/:id/services`).
   - **Service ki taraf se:** service kholo, jin jin companies ko deni he chuno (`PUT /api/v1/services/:id/companies`).
   Dono men poori list bheji jati he: jo list men he use mil jati he, jo nahi he us se hat jati he. Har tabdeeli audit log men likhi jati he.
2. **Login, screen ek hi he:**
   - super admin: **super admins ka code** + email + password (dekhen neeche "Super admins ka code")
   - client admin aur company users: **company code** + email + password
   - Ek hi email do companies men ho sakti he. Company code se pata chalta he kaun sa account he.
3. **Login ka jawab** ab batata he: kaun he (`userType`), kis company ka he (`company`) aur us ke menu men kaun si services hon (`services`, har ek ke saath `FULL` ya `VIEW`). Client admin ko apni company ki saari services `FULL` milti hen. Users ki services Step 2c men aayengi.
4. **Company band karna** (`isActive: false`): us company ke sab log foran logout ho jate hen aur login bhi nahi kar sakte, jab tak super admin dobara chalu na kare.
5. **Services ki list** pehle se tayyar he (15 services). Super admin nayi service jor sakta he, aur kisi service ko band kar sakta he. Band service har company ke menu se foran hat jati he.

## Nayi files
| File | Kaam |
|---|---|
| `migrations/20261010000002-create-companies-services.js` | 3 naye tables: `services` (15 services ke saath), `companies`, `company_services`. `users` ko companies se jorta he, aur email ko "poore system men ek" ki jagah "har company men ek" banata he. |
| `src/models/Company.js`, `Service.js`, `CompanyService.js` | In tables ke models. Company code hamesha capital harfon men, `XXXX-XXXX` shakal men save hota he. |
| `src/services/accessService.js` | Login aur `/me` ka jawab banata he: user, company, services. |
| `src/services/companyService.js` | Company register, list, details, badalna, band karna, services badalna. Har kaam audit log men. |
| `src/services/serviceCatalogService.js` | Services ki list, nayi service, service badalna/band karna, aur ek service kai companies ko ek saath dena ya wapas lena. Band service kisi company ko nahi di ja sakti. |
| `src/validators/companyValidator.js`, `serviceValidator.js` | In forms ke qaide (code ki shakal, password ka qaida, faltu field mana). |
| `src/controllers/companyController.js`, `serviceController.js` | HTTP ko service tak le jate hen. |
| `src/routes/companyRoutes.js`, `serviceRoutes.js` | `/api/v1/companies` aur `/api/v1/services`, sirf super admin. |
| `tests/companies.test.js` | 11 naye tests. |

## Badli hui files
- `authService.js`: login men company code. Super admins ka code ho to sirf super admin dhoonde jate hen, company ka code ho to sirf usi company ke log. Har ghalti ka ek hi jawab aata he: "Company code, email or password is incorrect".
- `authenticate.js`: har request par yeh bhi check hota he ke user ki company chalu he.
- `authController.js`: `/me` ab login jaisa poora jawab deta he (user, company, services).

## Aapko kya karna he
```
npm run db:migrate
npm run dev
```
`db:migrate` sirf nayi migration (`20261010000002`) chalayega. Aapka super admin aur purana data wese hi rahega.

## Random company code (12 October ki tabdeeli)
Pehle code company ke naam se banta tha (`waqas-textile`). Is ka andaza koi bhi laga sakta tha. Ab:
- Code **server khud random** banata he: 8 harf/number, beech men dash, maslan `K7QM-4XPA`. Super admin na code likh sakta he na badal sakta he.
- Is men 0/O, 1/I/L jaise milte julte harf nahi hote, taake phone par batana aur likhna aasan ho. Kul lag bhag 850 arab mumkin codes hen, aur har code unique he.
- Code `crypto.randomInt` se banta he (Node ka mehfooz random), `Math.random` se nahi.
- Login par code chhote harfon men, ya dash ke baghair (`k7qm4xpa`) likha ho to bhi chal jata he.
- Code ghalat bande tak pahunch jaye to super admin **naya code** bana sakta he: `POST /api/v1/companies/:id/new-code`. Purana code foran band. Audit log men `COMPANY_CODE_CHANGED` (purana aur naya code) likha jata he.

### Files
| File | Kaam |
|---|---|
| `src/utils/companyCode.js` | Random code banana (`generate`) aur likhe hue code ko ek shakal men lana (`normalize`). |
| `migrations/20261012000001-random-company-codes.js` | Database ka qaida badalta he, aur **pehle se bani har company ko naya random code** deta he (audit log men likh kar). |
| `companyService.js` | Register par random code; `newCode` naya code banata he. |
| `companyValidator.js` | Register aur update men `code` ab mana he (bheja to 400). |

### Aap ko kya karna he
1. `npm run db:migrate`
2. Jo companies pehle bani thin un ke code badal gaye hen. Naya code `GET /api/v1/companies` se dekh len aur company admin ko bata den.

## Super admins ka code (12 October ki doosri tabdeeli)
Ab **har koi** login par code likhta he, super admin bhi. Is se login screen sab ke liye bilkul ek jaisi he: Code, Email, Password.
- Sab super admins ka **ek hi code** he (maslan `R4TW-9KXE`). Yeh bhi random he, aur kabhi kisi company ke code jaisa nahi hota.
- Code table `platform` men rakha he (is men sirf ek row hoti he).
- Code dekhna: `npm run superadmin:code` (server wale computer par), ya app men `GET /api/v1/super-admins/login-code`.
- Naya code: `POST /api/v1/super-admins/login-code/new`. Purana foran band, audit log men `SUPER_ADMIN_CODE_CHANGED`. Baqi super admins ko naya code bata den.
- Code ke baghair login ab 400 deta he ("companyCode is required").

### Files
| File | Kaam |
|---|---|
| `migrations/20261012000002-platform-login-code.js` | `platform` table banata he aur pehla random code daalta he. Chalne par code screen par dikhata he. |
| `src/models/Platform.js` | Us table ka model. |
| `src/services/loginCodeService.js` | Free random code dhoondna (companies aur super admins dono se alag), super admins ka code dena aur naya banana. |
| `scripts/show-superadmin-code.js` | `npm run superadmin:code` |

### Aap ko kya karna he
1. `npm run db:migrate`: aakhir men "Super admin login code: ...." dikhega. Yeh code yaad rakhen.
2. Login karte waqt Company code ke khane men yahi code likhen. Baqi 3 super admins ko bhi yahi code den.
