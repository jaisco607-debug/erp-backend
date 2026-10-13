# Step 3: Grey inward (kapra aana)

## Kya bana
- **Customers** (`customers` table): woh parties jo kapra bhejti hain. Har company ki apni list, har party ka number (jaise AZ TEXTILES (130)).
- **Qualities** (`qualities` table): kapre ki qualities ki list.
- **Grey lots** (`grey_lots` table): har dafa jo kapra aaye, us ki ek entry = ek lot.
- **Company counters** (`company_counters` table): agla lot number aur type number yaad rakhta hai.

## Ahem rules
1. **Lot number aur Type number server khud deta hai**, ek ke baad ek. Do log ek hi waqt save karein tab bhi number kabhi double nahi hota (counter row lock hoti hai).
2. **Purane system se aage chalana**: client admin `PUT /v1/grey-lots/numbering` se bata sakta hai ke agla lot 2437 ho. Peeche (pehle se istemal hue number par) nahi ja sakta.
3. **Ek maal kai hisson mein aaye** (5000 m = 2000 + 1500 + 1500): har hissa alag lot. `partyRef` mein party ka order number likh dein to teeno lot search se ek saath mil jayenge.
4. **Re-process**: jo kapra wapas aaye, woh bhi yahin entry hoga, `isReprocess: true` ke saath. Chahein to `reprocessOfLotId` mein purana lot jod dein.
5. **Active toggle**: lot delete nahi hota, sirf off/on hota hai.
6. **Approve**: approve hone ke baad lot edit nahi hota. Approval sirf client admin wapas le sakta hai.
7. **Balance** = inward meters - outward meters. Outward agle steps (departments ko bhejna) mein bharega.
8. **Kaun kya kar sakta hai**: company ke paas Grey Store service honi chahiye. User ko VIEW mila ho to sirf dekh sakta hai, FULL ho to add/edit/approve.
9. Har add, edit, toggle aur approve audit log mein jata hai.

## Files
- `migrations/20261013000001-grey-inward.js`: chaaron tables.
- `src/models/Customer.js`, `Quality.js`, `GreyLot.js`, `CompanyCounter.js`
- `src/middlewares/requireService.js`: check karta hai ke user ke paas service hai (VIEW/FULL).
- `src/services/counterService.js`: agla number.
- `src/services/masterService.js`: customers aur qualities.
- `src/services/greyLotService.js`: lots ke saare rules.
- `src/validators/greyValidator.js`, `src/controllers/greyController.js`, `src/routes/greyRoutes.js`
- `tests/grey.test.js`
