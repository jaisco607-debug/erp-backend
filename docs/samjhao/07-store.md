# Step 7: Chemical Store aur General Items Store

## Kya bana
- **Vendors** (`vendors` table): jin se maal khareedte hain. Dono stores ki ek hi list. Har vendor ka number khud lagta hai, jaise NEXUS CHEMICAL (197).
- **Category aur Brand** (`store_categories`, `store_brands`): har store ki apni list.
- **Items** (`store_items`): naam, unit (KG, LTR, PCS ...), category, brand. Isi row mein item ka maujooda stock (`stockQty`) aur us ki kul qeemat (`stockValue`) rehti hai. Average rate = stockValue ÷ stockQty.
- **Inward entry** (`store_inwards` + `store_inward_lines`): ek bill. Pehle UN-APPROVED (draft) banti hai. Rate pata na ho to khaali chhor sakte hain.
- **Approve**: har line ka rate aur vendor zaroori. Approve par IP# milta hai aur stock barhta hai.
- **Stock history** (`store_moves`): stock ki har tabdeeli ka record. Aage Step 8 mein departments ko diya gaya chemical bhi yahin likha jayega.

## Files
- `migrations/20261014000002-stores.js`: tables, aur GENERAL_STORE service har company ko.
- `src/models/Store.js`: saare store models ek file mein.
- `src/services/storeMasterService.js`: vendors, categories, brands, items.
- `src/services/storeInwardService.js`: inward entry, approve, un-approve, stock, item history.
- `src/validators/storeValidator.js`, `src/controllers/storeController.js`, `src/routes/storeRoutes.js`.
- `tests/stores.test.js`: poora flow test.

## Hifazat
- URL mein `chemical` ho to CHEMICAL_STORE service chahiye, `general` ho to GENERAL_STORE.
- VIEW wala sirf dekh sakta hai; FULL wala bana aur approve kar sakta hai; approval wapis sirf client admin.
- Do log ek saath approve karen to bhi stock ghalat nahi hota (item rows lock hoti hain).
- Har kaam audit log mein jata hai.
