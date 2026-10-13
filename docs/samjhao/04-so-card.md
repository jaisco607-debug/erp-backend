# Step 4: SO card (travel card)

## Kya bana
- **`so_cards`**: har SO card ki ek row: card#, date, party, total meter/thaan, status, abhi kis department mein hai.
- **`so_card_lots`**: card ka kapra kin lots se aaya, aur har lot se kitna meter/thaan.
- **`so_card_moves`**: card ka safar: kis department ko bheja, kis ke zariye, kab, aur kab accept hua.

## Flow
1. **Card banana**: Grey ke approved lots mein se ek ya kai lot chunein (sirf **ek hi party** ke), har lot se kitna meter lena hai likhein.
   Misaal: lot A (4000 m) se 2000 m + lot B (3000 m) se 1500 m = ek card, 3500 m.
2. **Grey ka stock khud kam hota hai**: lot A ka outward 2000, balance 2000 reh jata hai. Balance se zyada meter lena mumkin nahi (do log ek saath save karein tab bhi nahi, lots lock hote hain).
3. **Re-process**: re-process wale lot se bhi card banta hai; card par `isReprocess: true` aa jata hai.
4. **Department ko bhejna**: card banne ke baad department chunein (Singeing, Dyeing ...) aur "kis ke zariye" likhein. Status `SENT`.
5. **Accept**: woh department (us ka FULL access wala user, ya client admin) Accept dabata hai. Status `IN_DEPARTMENT`.
6. Phir wahan se agle department ko bheja ja sakta hai; har trip `moves` mein likhi jati hai.
7. **Cancel**: jo card abhi kahin nahi bheja, woh cancel ho sakta hai; us ke meter wapas lots mein chale jate hain. Card number dobara nahi milta.

## Status
`NEW` (bana, bheja nahi) → `SENT` (department ki taraf ja raha) → `IN_DEPARTMENT` (department ne accept kar liya)

## Files
`migrations/20261013000006-so-cards.js`, `src/models/SoCard.js`, `SoCardLot.js`, `SoCardMove.js`,
`src/services/soCardService.js`, `src/validators/soCardValidator.js`, `src/controllers/soCardController.js`,
`src/routes/soCardRoutes.js`, `tests/soCards.test.js`
