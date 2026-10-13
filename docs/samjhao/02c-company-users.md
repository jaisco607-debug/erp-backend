# Step 2c: Company admin apne users banaye

## Kya bana
1. **Company admin (client admin) apni company ke users banata he:** naam, email, password, aur services.
2. Har service ke saath ijazat:
   - `FULL`: add aur edit kar sakta he
   - `VIEW`: sirf dekh sakta he aur report nikal sakta he
3. **User ka login:** usi company ka code + apni email + apna password. Login ke jawab men `userType: "USER"` aur sirf us ki apni services aati hen (har ek ke saath `access`). Front end inhi se user ka menu banata he.
4. Company admin user ka naam badal sakta he, use band (`isActive: false`) kar sakta he, aur us ka password reset kar sakta he. Band karne ya password reset karne par user foran har device se logout ho jata he.

## Hifazat ke qaide
- Company admin **sirf apni company** ke users dekh aur badal sakta he. Doosri company ke user ki id bheje to jawab 404 ("nahi mila"), taake pata bhi na chale ke woh user mojood he.
- Company admin user ko **sirf woh services** de sakta he jo super admin ne company ko di hen. Koi aur service bheje to 422 `SERVICE_NOT_IN_COMPANY`.
- Jab super admin company se koi service wapas le leta he, to company ke **sab users se bhi woh service khud hat jati he**. Baad men service company ko dobara mile, tab bhi users ko khud wapas nahi milti; company admin dobara dega.
- Service band (switch off) ho to kisi ke menu men nahi aati.
- Ek company men ek email ek hi dafa (409). Doosri company men wahi email chal sakti he.
- Har kaam audit log men likha jata he, company ke naam ke saath: `COMPANY_USER_CREATED`, `COMPANY_USER_UPDATED`, `PASSWORD_RESET`, `USER_SERVICES_CHANGED` (pehle aur baad ki services, maslan `DYEING:VIEW`). Password kabhi audit log men nahi jata.
- Yeh APIs sirf company admin chala sakta he. User ya super admin chalaye to 403.

## APIs (sab `/api/v1/users` ke neeche, company admin ka token chahiye)
| Kaam | API |
|---|---|
| Users ki list | `GET /users?search=ali&page=1&limit=25` |
| Naya user | `POST /users` |
| Ek user | `GET /users/:id` |
| Naam badalna / band karna | `PATCH /users/:id` |
| Password reset | `POST /users/:id/reset-password` |
| Services badalna | `PUT /users/:id/services` (poori list bhejen) |

Services ki `id` kahan se: company admin ke login (ya `/auth/me`) ke jawab men `services` = company ki sab services, har ek ki `id` ke saath.

## Files
| File | Kaam |
|---|---|
| `migrations/20261012000003-create-user-services.js` | Table `user_services`: kis user ko kaun si service, `VIEW` ya `FULL`. User mitey to us ki services bhi mit jati hen. |
| `src/models/UserService.js` | Us table ka model. |
| `src/services/companyUserService.js` | Users banana, badalna, password reset, services dena. Har jagah company admin ki apni company ki shart. |
| `src/services/accessService.js` | User ke menu men ab us ki apni services aati hen: jo di gayin **aur** abhi company ke paas hen **aur** chalu hen. Har service ke saath ab `id` bhi aati he. |
| `src/services/companyService.js`, `serviceCatalogService.js` | Company se service hate to us ke users se bhi hata do. |
| `src/validators/companyUserValidator.js` | Form ke qaide (access sirf VIEW/FULL, ek service ek dafa, password ka qaida). |
| `src/controllers/companyUserController.js`, `src/routes/companyUserRoutes.js` | APIs ke raste. Sirf `CLIENT_ADMIN`. |
| `tests/companyUsers.test.js` | 7 tests: upar ke sab qaide. |

## Aap ko kya karna he
1. `npm run db:migrate`
2. Company admin se login karen (company code + us ki email + password).
3. `POST /api/v1/users` se user banayen. Phir usi company code + user ki email + password se login kar ke dekhen.
