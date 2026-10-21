# Step 8: Reports (poore system ki reports)

## Kya bana
- **Reports ki services**: har report group ki apni service (dekhen [09-service-access.md](09-service-access.md)). Super admin company ko deta hai, client admin user ko (VIEW kaafi hai, reports sirf parhi jati hain). Pehle ek hi `REPORTS` module tha, wo ab nahi.
- **`/api/v1/reports/...`**: 16 reports, sab sirf `GET`. Database mein kuch nahi likhti.
- Har report ka jawab ek hi shakal ka hota hai: `columns` (kaunsa column, kis qism ka number), `rows`, `totals`. Is liye frontend ek hi table bana kar har report dikha sakta hai, aur usi se PDF aur Excel bana leta hai. `all=true` se saari rows ek saath aati hain (download ke liye).

## Kaunsi reports
| Report | Kya batati he |
|---|---|
| overview | har module ke bare numbers, aur abhi kapra kahan hai |
| grey/parties | har party ka kitna kapra aya, wapis diya, SO card par gaya, grey store mein para, departments mein active, pack hua, gate pass se nikla |
| grey/lots | har lot ka hisaab |
| grey/returns | party ko bina process wapis diya gaya kapra |
| so-cards | har SO card: lots, thaan, meter, kin departments se guzra, kitna kahan hai, chemical cost |
| so-cards/lots | SO card ki har lot aur us ke thaan numbers (meter ke saath) |
| so-cards/:id | ek SO card ki poori kahani: lots, thaan, departments ka raasta, chemicals, folding, packing, gate pass |
| departments | har department mein kitni jobs, SO cards, lots, thaan, meter; status wise; chemical cost; abhi kitna kapra para he |
| departments/jobs | kis department ko kaunsa SO card gaya, kitni lots, thaan, meter, operator |
| departments/operators | kis operator ne kitni jobs / SO cards / meter kiye |
| chemical-cost | chemical costing SO card, lot, thaan, chemical ya har chemical ke hisaab se |
| folding | folding mein kahan se aya, kitna aya, A / B / CP, kitna packing ko gaya, kitna abhi para he |
| active-fabric | abhi kapra kahan hai: party wise, SO card wise, department wise, ya har tukra |
| packing-lists, packing-lists/lines | packing lists aur un ke thaan |
| gate-passes | gate pass se nikla hua kapra |

## Kapra abhi kahan hai (hisaab ka tareeqa)
Har SO card ki lot ke meter:
- **SO card not sent**: card par hai, kisi department ko nahi gaya.
- **In departments**: kisi process department mein (In-Way se Complete tak).
- **In folding**: Folding mein, aage nahi gaya (band ki hui folding row mein kuch nahi rehta).
- **In packing**: Packing tak pohncha, gate pass abhi nahi bana.
- **Dispatched**: packing list ka gate pass ban gaya, kapra factory se nikal gaya.
Reject hui job ka kapra wapis bhejne wale ke paas gina jata hai. Folding mein meter barh / ghat sakte hain, is liye packing ke meter graded meter hain.

Chemical cost: store ne jo bheja (wapsi ke baad). SO card wali request usi card ko, poori job wali request meter ke hisaab se baant di jati hai; phir lot aur thaan par bhi meter ke hisaab se.

## Files
- `migrations/20261020000001-reports-module.js`: pehle ek `REPORTS` module banata tha (ab `20261020000002` use 9 services mein badal deta hai).
- `src/services/reportService.js`: saari reports aur hisaab.
- `src/routes/reportRoutes.js`: URLs aur filters ki jaanch.
- `tests/reports.test.js`: grey se gate pass tak poora flow, phir har report ke numbers check.
- Frontend ke liye: `docs/frontend/reports.md` (PDF / Excel banane ka tareeqa bhi).
