# Step 9: Super admin har service khud deta he (kuch bhi default nahi)

## Kya badla
- **Nayi company ko ab koi service nahi milti**, modules bhi nahi (pehle Grey Store, SO Card, Chemical Store, General Store, Packing, Gate Pass khud mil jate thay). Ab super admin wahi deta he jo client ne manga.
- Modules ab bhi company ko diye aur wapis liye ja sakte hen (pehle `MODULE_SERVICE` ka error aata tha). Purani companies ke paas jo he wo rehta he; super admin ab usay hata bhi sakta he.
- **Reports ki alag alag services**: ek `REPORTS` ki jagah 9 services: `REPORT_OVERVIEW`, `REPORT_GREY`, `REPORT_SO_CARDS`, `REPORT_DEPARTMENTS`, `REPORT_CHEMICAL_COST`, `REPORT_FOLDING`, `REPORT_ACTIVE_FABRIC`, `REPORT_PACKING`, `REPORT_GATE_PASSES`. Jis report ki service nahi, us par 403, aur `GET /v1/reports` mein wo report nazar hi nahi aati.
- **Store ki reports alag**: `STORE_REPORTS`. Store ke chemical cost reports (`/v1/stores/chemical/cost/...`) ab `CHEMICAL_STORE` se nahi, `STORE_REPORTS` se khulte hen. Chemical aur General alag alag diye ja sakte hen (ek, dono, ya koi nahi). `CHEMICAL_STORE` mile to chemical ki saari screens khul jati hen.
- **Har service ka `menuGroup`**: `PRODUCTION`, `PROCESS`, `STORE`, `REPORTS` (client ka kaun sa tab). Frontend isi se menu banata he: item tab hi nazar aaye jab uski service ho; tab tab hi nazar aaye jab uske andar koi item nazar aaye.
- `isBuiltIn`: system ki apni services jo delete nahi hoti (delete ka button chhupane ke liye).

## Purane data ka kya hua (migration)
- Jis company / user ke paas `REPORTS` thi, usay nau ki nau report services mil gayen (VIEW / FULL wahi). `REPORTS` hat gayi.
- Jis ke paas `CHEMICAL_STORE` thi, usay `STORE_REPORTS` mil gayi, taake cost reports band na hon.
- `down` bhi bana he (wapis `REPORTS` aa jati he).

## Files
- `migrations/20261020000002-granular-services.js`: `menuGroup`, kind `REPORT`, 10 nayi services, purani ka tabdeel hona.
- `src/services/companyService.js`: company banate waqt koi service nahi di jati.
- `src/services/serviceCatalogService.js`: modules dena theek, `menuGroup`, `isBuiltIn`.
- `src/routes/reportRoutes.js`, `src/services/reportService.js`: har report ki apni service, catalog filter.
- `src/routes/storeRoutes.js`: cost reports par `STORE_REPORTS`.
- `tests/serviceAccess.test.js`: kuch default nahi, super admin ka dena aur lena, store alag alag, reports ka access.
- Frontend ke liye: `docs/frontend/service-access.md` (super admin aur client dono taraf ke steps).

## Fabric return ka apna number (FR-1, FR-2)
- Fabric return ab SO number nahi leta; uski apni series he (FR-1, FR-2 ...) aur SO numbers beech mein gap ke bina chalte hen. Dono series 1 se shuru hoti hen, is liye screens par `cardLabel` ("5" ya "FR-5") dikhana he, sirf number nahi.
- `migrations/20261020000003-fabric-return-numbers.js`: SO number ki uniqueness "company + fabric return he ya nahi + number" ki ho gayi. Pehle bane hue fabric return apna number rakhte hen (FR-19 jaise).
- `src/utils/soLabel.js`: label banana aur "FR-3" search samajhna.
