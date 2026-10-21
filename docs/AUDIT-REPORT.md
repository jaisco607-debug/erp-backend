# Textile ERP Backend: Audit Report

**Tareekh:** 2026-10-21  
**Kya dekha gaya:** poora backend code, poora database design, aur aap ka asli (Supabase) database (sirf parha, kuch badla nahi).  
**Audit ke dauran `src/` mein kuch nahi badla gaya; masle report ke baad aap ke kehne par theek kiye gaye (section 0 dekhein).**


---

## 0. FIX STATUS (2026-10-21): masle theek kar diye gaye (AUD-04 ke siwa)

Aap ke kehne par AUD-04 (Folding grading limit) ke siwa baqi masle theek kiye gaye. Har fix ka test pehle fail hota tha, ab pass hota hai (`test.failing` se normal `test` bana diya). **Ab poora suite: 182 tests, 181 pass, 1 skip (speed), sirf 1 `test.failing` baqi (AUD-04).**

| ID | Natija | Kya kiya |
|---|---|---|
| AUD-01 | Fixed | `previousCosts`: split hone par har hissa sirf apne meters ka cost uthata hai (Rs 1000, doguna nahi) |
| AUD-02 | Fixed | Ek hi rounding function (`src/utils/money.js`): half paisa hamesha upar; saari services istemal karti hain |
| AUD-03 | Fixed | Jis job par chemical request ho wo reject nahi ho sakta (`CANNOT_REJECT`) |
| AUD-04 | **Chhora gaya** (aap ka faisla baqi) | Folding grading par abhi koi limit nahi |
| AUD-05 | Fixed | Packing list line <= Folding ka bheja hua (thaan + category ke hisaab se, saari lists mila kar) |
| AUD-06 | Fixed | Gate pass wali list reopen/delete nahi hoti (`HAS_GATE_PASS`) |
| AUD-07 | Fixed | Asli tareekh ki check (body aur har filter): 400, 500 nahi |
| AUD-08 | Fixed | Thaan wali lot ko plain total se edit karna mana (`LOT_HAS_THAANS`) |
| AUD-09 | Fixed | SO card ka raasta sirf us ka jis ke department ne card dekha (ya SO Card/Grey Store); admin sab |
| AUD-11 | Fixed | Purana accept ab 422 `ACCEPT_ON_JOB`; incoming list sirf asli waiting cards |
| AUD-12 | Fixed | SO card ki `currentDepartment` / `deliveryText` ab cloth ki asli jagah batate hain; report ka "Last sent to" bhi |
| AUD-13 | Fixed | Packing totals = lines ke amounts ka jor (list, thaan-wise report, SO card detail, kagaz sab ek) |
| AUD-14 | Fixed | Default tareekh aur din ke filters Pakistan (Asia/Karachi) ke din se |
| AUD-15 | Fixed | Store request se zyada nahi bhej sakta (`MORE_THAN_REQUESTED`); kam bhej sakta hai |
| AUD-16 | Fixed | Bohot bade number: 400 `NUMBER_TOO_BIG` (500 nahi) |
| AUD-17 | Fixed | SO card lot ke aane se pehle ki tareekh nahi; job card se pehle nahi; gate pass list se pehle nahi |
| AUD-18 | Fixed (migration) | `20261021000001`: har foreign key par index (81 -> 0 baqi) |
| AUD-19 | Fixed (migration) | 25 columns par `CHECK >= 0` (NOT VALID: purana data nahi chhera jata, nayi rows check hoti hain) |
| AUD-20 | Nahi badla | Bade data par Folding list/send-form poora data uthate hain. 1,000 jobs tak 0.5 s se kam hai; 10,000+ par dekhna parega |
| AUD-21 | Nahi badla | Ye aap ka `.env` / server setting hai (JWT secret 32+ characters, login lock 15 minute, nginx ke peeche chalana) |
| AUD-22 | Nahi badla | Purana data (14 Oct se pehle ke jobs) sirf khaali nazar aata hai |
| AUD-23 | Fixed | Recursive queries mein `UNION` (repeat par ruk jati hain); company code ki koshish 50 tak |

**Dhyan dein:** migration `20261021000001-audit-indexes-and-checks.js` aap ke **asli database par abhi nahi chalayi gayi** (sirf test database par seedhi aur ulti chali). Jab chahein `npm run db:migrate` chala dein. Code is migration ke baghair bhi theek chalta hai.

Frontend ke liye alag guide: `docs/frontend/audit-fixes.md`.

*Neeche ki report asli audit ka matn hai (masle jaise us waqt mile thay).*

---

## 1. Natija ek nazar mein

| Sawal | Jawab |
|---|---|
| **Costing (chemical ka hisaab) kharab to nahi?** | **Core costing theek hai.** Khareed, average rate, batch ke hisaab se issue, return, adjustment: lagbhag **1,900 random operations** ke baad bhi stock aur paisa ek paisa idhar-udhar nahi hua. Ek alag hisaab (shadow model) se har qadam par milaya gaya. Job, SO card, lot, thaan ka cost har report mein ek jaisa aata hai. **Lekin 2 jagah costing/amount ke numbers ghalat dikhte hain** (AUD-01, AUD-13) aur ek rounding ki chhoti kami hai (AUD-02). Detail neeche. |
| **Kapre (meters) ka hisaab?** | Theek. Har meter kahin na kahin gina jata hai (grey store, SO card, department, folding, packing, dispatch). Kapra na banta hai na gum hota hai. |
| **Loop ya loophole?** | Koi infinite loop nahi. **Loopholes mile:** processed job ko reject karna (AUD-03), packing list mein jitna marzi kapra likhna (AUD-05), gate pass ke baad list kholna aur gate pass mita dena (AUD-06), Folding mein grading ki koi hadd nahi (AUD-04). |
| **Security?** | Ek company dusri ki koi cheez nahi dekh/badal sakti (**3,300 se zyada hamle ki calls**). Token/role/VIEW-only sab theek. Chhoti kamiyan neeche. |
| **Bugs (crash)?** | 3 qism ke 500 errors mile: ghalat tareekh (AUD-07), purana accept call (AUD-11), bohot bade numbers (AUD-16). |
| **Asli database ki sehat?** | **37 hisaab ke rules mein se 37 theek.** Purane data ke 3 chhote nishan alag likhe hain (AUD-22). |
| **Speed?** | 1,000 lots/cards/jobs par har screen aur report 0.5 second se kam. Kahin N+1 nahi. |

**Bottom line:** project ka financial core mazboot hai. Jin cheezon ko go-live se pehle dekhna chahiye wo ye 5 hain: **AUD-05, AUD-06, AUD-03, AUD-01, AUD-12**. Baqi sab baad mein ho sakti hain.

---

## 2. Kya kya test kiya (tareeqa)

Aap ke diye hue har scenario ko test banaya, aur do tarah ke sakht check lagaye:
1. **Hisaab ke rules (invariants):** 37 rules (`scripts/audit/invariants.js`), har ek ek SQL jo ghalat rows dikhati hai. Jaise: "item ka stock = uske batches ka jor", "lot ka outward = SO cards + wapas diya hua", "ek hi cloth do baar nahi bheja gaya", "packing list = jitna Packing ne wasool kiya". Ye har test ke baad chalaye, aur aap ke **asli database par** bhi (read-only).
2. **Alag hisaab se muqabla:** random operations ko ek dusre, apne alag banaye hue FIFO model se milaya.

| Hissa | Kya hua | File |
|---|---|---|
| Costing scenarios | 12 (average rate, batch pick, return, cost bantwara, rework loop, negative stock, unapprove, adjustment, rounding) | `tests/audit/costing.test.js` |
| Random costing | 12 seeds x 160 qadam (lagbhag 1,900 operations), har qadam par stock/value check | `costing-fuzz.test.js` |
| Kapre ka flow | 21 (yards, thaan ke hisse, SO card edit, give-back, lot unapprove, double send, status machine, reject/dispute, 6-hop rework, folding, packing, gate pass, fabric return) | `cloth.test.js` |
| Mushkil flows | 3 (ek job mein 3 SO cards, reject/undo/dispute, doosre department ka kapra) | `flows.test.js` |
| Concurrency | 12 (8 log ek hi lot se SO card, ek request 3 baar send, 20 khareed ek saath ...) | `concurrency.test.js` |
| Reports ka mel | 5 (har meter ka hisaab, paging/all=true, active fabric, packing paise) | `reports-consistency.test.js` |
| Security | 8: har GET/DELETE route x har id (1,803 calls), 60+ valid badalne wali calls dusri company se, bina token/jaali token, roles, VIEW-only, mass assignment | `security.test.js` |
| Kharab input | har route par kharab body/query (**8,986 calls**), super admin routes (**1,485 calls**) | `robustness.test.js`, `superadmin.test.js` |
| Audit log | 54 badalne wali calls, har ek ka record bana; log mein password nahi; log badla nahi ja sakta | `auditlog.test.js` |
| Time zone | 2 | `time.test.js` |
| Bohot bade numbers, General Store | 4 | `extremes.test.js` |
| Urdu/emoji | 1 (naam aur search har jagah) | `unicode.test.js` |
| Speed (1,000 lots/cards/jobs) | 1 (alag se chalta hai) | `performance.test.js` |
| Database design | indexes, constraints, cascade, migrations ulti/seedhi (40 migrations) | script |
| Config/secrets | `.env`, JWT, CORS, helmet, `npm audit` (0 vulnerabilities), git mein secrets | review |

**Total:** 36 suites, **182 tests** (purane 101 + audit 81). 181 pass, 1 skip (speed wala, jaan-bujh kar). **21 tests `test.failing` hain**: ye wo masle hain jin ka sahi behaviour test mein likha hai aur wo abhi fail hota hai. Masla theek hone par wo test khud batata hai ("ab pass ho gaya") aur aap `.failing` hata dete hain.

---

## 3. Masle (severity ke hisaab se)

Severity: **HIGH** = go-live se pehle dekhna chahiye, **MEDIUM** = jaldi, **LOW** = waqt mile to.

### HIGH

#### AUD-05: Packing list mein jitna marzi kapra likha ja sakta hai
- **Kya hota hai:** ek thaan 100 m ka hai, packing list mein us par **5000 m** ki line ban jati hai (201 Created). List mein sirf ye check hota hai ke thaan SO card ka hai, meters ki koi hadd nahi (na Folding ke bheje hue se, na received se).
- **Asar:** packing list/invoice aisa kapra dikhati hai jo mojood hi nahi. Amount (meters x rate) bhi galat. Aap ke asli data mein ye abhi nahi hua (rule PACK-01 theek hai), lekin rokne wala koi check nahi.
- **Test:** `Packing list cannot hold more cloth than Folding sent` (cloth.test.js)
- **Suggested fix:** list ki har (thaan, grade) ka jor <= Folding ne jitna bheja (sentA/sentB/sentCP) ho, aur total <= Packing ne jitna accept kiya. **Mehnat:** chhota (S).

#### AUD-06: Gate pass ke baad packing list kholi aur mita di ja sakti hai (gate pass bhi mit jata hai)
- **Kya hota hai:** `reopen` FINAL list ko DRAFT bana deta hai chahe gate pass ban chuka ho. Phir list edit ho sakti hai ya delete. Delete par gate pass bhi khud mit jata hai (database mein `ON DELETE CASCADE`). Test mein gate pass ginti 1 se 0 ho gayi.
- **Asar:** kapra factory se nikal chuka, lekin uska dispatch record aur gate pass ghayab ya badal sakta hai. Audit log mein sirf "list deleted" likha hoga.
- **Tests:** `a packing list that already has a gate pass cannot be reopened...`, `after the gate pass is made, reopening and deleting...`
- **Suggested fix:** gate pass wali list par reopen/edit/delete mana. Gate pass ko bhi cascade se bachana. **Mehnat:** S.

#### AUD-03: Poora ho chuka job "wapas Pending" kar ke reject kiya ja sakta hai (chemical lag chuke hon tab bhi)
- **Kya hota hai:** dropdown se COMPLETE -> PENDING allowed hai, aur PENDING se REJECT allowed hai. Yani process ho chuka kapra (jis par Rs 1,000 ke chemical lag chuke) bhejne wale ko wapas kiya ja sakta hai.
- **Asar (costing):** chemical store se nikal chuke (store cost screen Rs 1000 dikhati hai), lekin jab bhejne wala kapra dobara aage bhejta hai to **kapre ke apne cost-raaste mein Rs 0** aata hai. Dono screens ka cost alag.
- **Tests:** `LOOPHOLE: a department steps a finished job back...`, `LOOPHOLE (consequence)...`
- **Suggested fix:** reject sirf tab jab job ne PROCESSING nahi dekhi aur koi chemical request nahi; ya COMPLETE/PROCESSING se PENDING par wapsi mana. **Mehnat:** S.

#### AUD-01: Packing ki screens par chemical cost **doguna** dikhta hai (jab Folding kapra do hisson mein bhejti hai)
- **Kya hota hai:** Dyeing mein 300 m par Rs 1000 ke chemical lage. Folding ne 100 m aur 200 m do baar Packing ko bheje. Packing ki incoming list mein dono rows ka `previousChemicalAmount` jor = **Rs 2000** (sahi Rs 1000).
- **Wajah:** `previousCosts` (jobService.js) har bachay ko poore parent item ka cost de deta hai, bachay ke meters ke hisse ka nahi.
- **Kahan asar:** sirf Packing ki list/sent screens ke cost columns (`previousChemicalAmount`, `totalChemicalAmount`, `costPerMeter`). **Sahi cost wali screens (store cost reports, job/SO card cost, Folding rows, reports) theek hain.**
- **Test:** `Packing gets the chemical cost of the cloth ONCE...`
- **Suggested fix:** ancestor ka cost bachay ke meters/ancestor ke meters se taqseem karna. **Mehnat:** S-M.

#### AUD-12: SO card ki screen purani jagah dikhati hai (status aur department aage nahi badhte)
- **Kya hota hai:** naye job flow mein SO card ka `status` pehli baar bhejne par SENT hota hai aur wahin atka rehta hai. `currentDepartment` pehla department rehta hai. Kapra Folding mein accept ho chuka ho phir bhi card kehta hai "**Sent to Dyeing (waiting for accept)**".
- **Asar:** SO card list/detail ghalat jagah batate hain. (Meri banayi hui SO Cards report ka column "Last sent to" bhi isi wajah se pehla department dikhata hai.) Reports ke positions (jobs se) sahi hain.
- **Test:** `the SO card shows where its cloth is now`
- **Suggested fix:** card ki jagah jobs se nikalna (ya job ke har aage jane par card update karna). **Mehnat:** M.

### MEDIUM

#### AUD-04: Folding mein grading ki koi hadd nahi
200 m ka kapra aya, 5000 m grade ho kar Packing ko ja sakta hai (kam bhi). Shrinkage/gain ke liye koi tolerance (jaise 5%) nahi, na approval. Ye business ka faisla hai. **Test:** `Folding: grading more than received...`

#### AUD-11: `POST /so-cards/:id/accept` crash (500)
Jo SO card naye job flow se gaya ho (jis ka "move" record nahi banta), us par ye purana accept call `TypeError` se girta hai. Ye purani APIs (`/so-cards/:id/send`, `/accept`) naye flow ke saath mel nahi khati. **Test:** `the old SO card accept call does not crash...`

#### AUD-07: Ghalat tareekh (2026-02-30, 2026-13-01) par server 500 deta hai
Tareekh ki check sirf "4 ank-2 ank-2 ank" dekhti hai, asli tareekh nahi. `inwardDate`, aur **har date filter** (`dateFrom`) par ~25 list/report endpoints crash hoti hain. Fix: asli tareekh check (Joi date). **Mehnat:** S. **Tests:** `impossible dates...`, `a date filter with an impossible date...`

#### AUD-08: Thaan wali lot ko "sirf total" bana kar edit karne se lot ke meters aur thaans ka jor alag ho jate hain
Unapproved lot par `PATCH {inwardMeters: 999, pieces: 3}` jab lot ke thaans 300 m ke hon: lot kehta hai 999 m, thaans ka jor 300 m (rule CLOTH-03 toot jata hai). Fix: thaan wali lot par total se edit mana. **Test:** `a lot with thaans cannot be edited into a plain total`

#### AUD-13: Packing list ka total aur uski lines ka jor 2 paisa alag
Misal: total Rs 48.35, lines ka jor Rs 48.37 (har line alag round hoti hai, total alag). Dono packing reports (list aur thaan-wise) bhi alag total dete hain. Fix: ek hi tareeqa (total = lines ka jor). **Test:** `packing list money: the total equals the sum...`

#### AUD-14: Time zone: default tareekh UTC ki hai, Pakistan ki nahi
11 jagah `new Date().toISOString()` istemal hota hai. Raat 12 baje se subah 5 baje (Pakistan) ke beech bane entries par **pichli tareekh** lagti hai, aur din ke filter mein bhi wo pichle din mein ginay jate hain. Test mein ghadi 02:30 Pakistan par rakhi to job ki tareekh 21 ki jagah 20 aayi. Fix: ek jagah Asia/Karachi ki tareekh banana. **Mehnat:** S-M. **Tests:** 2 (time.test.js)

#### AUD-15: Chemical store request se kitna bhi zyada bhej sakta hai
Department ne 4 kg maange, store ne 90 kg bhej diye aur wo job par charge ho gaye. Koi hadd (request + tolerance) nahi. **Test:** `the store sends more than the department asked for`

#### AUD-09: Company ke andar ek department ka employee kisi bhi SO card ka poora raasta dekh sakta hai
`GET /jobs/so-card/:id` mein department ki check nahi. Dyeing ka employee aisa card bhi dekh leta hai jo kabhi Dyeing mein gaya hi nahi (operators, rejection reasons, colours). Dusri company ka kuch nahi dikhta. **Test:** `INSIDE a company: a Dyeing employee reads...`

### LOW

| ID | Masla | Detail |
|---|---|---|
| **AUD-02** | Paise ki rounding | `Math.round(n*100)/100` kuch half-paisa ko **neeche** karta hai (0.29 kg x Rs 0.5 = 0.145 -> 0.14, sahi 0.15). Maine 20 lakh random lines nikaal kar naapa: **har 1,470 lines mein 1** line 1 paisa kam (rate 2 decimal ho to 0.068%; 4 decimal par 0.0018%). Stock aur cost dono ek hi function se chalte hain, to andar mel rehta hai; farq vendor ke asli bill se aata hai. Fix: integer paisa ya exact decimal. **Test:** `money rounding: every half-paisa...` |
| **AUD-16** | Bohot bade qty x rate par 500 | qty 900 million x rate 900,000 `numeric(16,2)` se bara ho kar database overflow se 500. Typo (extra zeros) par saaf message milna chahiye. **Tests:** 2 |
| **AUD-17** | Tareekh ki koi sanity nahi | SO card 2020 ki tareekh ka bana sakte hain jab lot 2026 mein aya; inward date 9999-12-31 bhi qabool. |
| **AUD-18** | **81 foreign keys par index nahi** | Jaise `job_items.soCardId`, `jobs.departmentId`, `folding_lines.soCardId`, `chemical_request_lines.requestId`, `packing_list_lines.packingListId`. Abhi (1,000 jobs) tak masla nahi, bade data par queries sust hongi. Ek migration se ban jate hain. |
| **AUD-19** | 39 paise/qty ke columns par `CHECK` nahi | Jaise `store_batches.valueLeft`, `chemical_request_lines.value`. Code theek chalta hai, lekin database ki hifazat nahi. (Lot, batch qty, job meters par check hain.) |
| **AUD-20** | Kuch screens poora data ek saath uthati hain | Folding list company ki saari folding rows memory mein laati hai (700 rows par 450 ms; ~10,000 par ~6 s). `jobs/form-data`, `send-form` bina paging ke. Reports har baar poori company ka cloth-position nikalte hain. |
| **AUD-21** | Config (dev) | Dev `.env` mein JWT secrets sirf 16-17 character ke aur sample jaise (production mein server 32 character se kam par chalta hi nahi, ye bachao maujood hai). Login lock/window dev mein **1 minute** par hain (asli 15 hone chahiye). `trust proxy = 1`: agar API seedha internet/LAN par khuli ho (jaise abhi 192.168.1.4:3000) to koi `X-Forwarded-For` jhoota bhej kar IP limit chhura sakta hai. Nginx ke peeche theek hai. |
| **AUD-22** | Purana data (asli database) | 11 jobs (14 Oct, flow badalne se pehle) par received/accepted ka waqt khaali. ~25 purani jobs par operator/process date nahi (Folding ki jobs par Packing bhejte waqt ye mangta hi nahi). 2 purani packing lists (SO 12, 13) Folding v1 ki hain (`folding_lines` nahi). Nuqsan nahi, bas purani screens par khaali nazar aa sakta hai. |
| **AUD-23** | Hifazati hadd nahi | Cloth ke raaste ki recursive queries mein depth ki hadd nahi, aur login code banane wala `for(;;)` mein koshish ki hadd nahi. Cycle ban hi nahi sakta (asli data mein sab se lamba raasta 6 qadam), isliye sirf ehtiyat. |

### Maloomati (masla nahi, bas jaan lein)
- **Account lock:** 5 ghalat password par account 15 minute lock hota hai. Ye apne aap mein theek hai, lekin company code aur email jaanne wala kisi ka bhi account lock kar sakta hai.
- **Audit log** mein poore record ke JSON snapshot hote hain, to bohot tezi se barhta hai (aik bade test ke baad 10,000 rows). Purane records ke liye retention/archiving ka koi tareeqa nahi.
- **Backup/restore:** is repo mein backup ka koi tareeqa ya jaanch nahi. Supabase ka apna backup use hota hai to uski setting khud check kar lein.
- **Gate pass ki service (`GATE_PASS`)** ab bhi sirf label hai; gate pass ke APIs Packing ke access par chalte hain.
- **General Store** mein sirf khareed aur adjustment hain, "department ko dena" nahi (design).

*(AUD-10 ka number khali hai: shuru mein ek jhoota alarm tha ke Urdu/emoji search crash karta hai; wo mere test database ki encoding (WIN1252) ki wajah se tha. Aap ka asli database UTF8 hai aur UTF8 par Urdu har jagah theek chalta hai, ye test bhi bana diya.)*

---

## 4. Jo cheezein theek nikli (pakki jaanch ke baad)

- **Stock aur value:** item ka stock aur value hamesha uske batches ke jor ke barabar; negative kabhi nahi; ledger (store_moves) stock se milta hai.
- **Average rate aur batch costing:** 20 kg @40 + 100 kg @45, 30 kg issue = Rs 1250 (800+450), baqi value 4050: bilkul sahi. Batch pick karne par us batch ka rate lagta hai.
- **Return:** wapas usi rate par, sab se naya issue pehle; job ka cost utna hi kam.
- **Rework loop:** Dyeing -> Folding -> wapas Dyeing -> Folding: har chemical ka cost sirf ek baar (Rs 1000 + Rs 500 = Rs 1500).
- **Cost bantwara:** ek request 3 SO cards mein meters ke hisaab se baantta hai, jor request ke barabar (2 paisa tak), aur **5 jagahon** (store cost, job cost, SO card cost, Folding row, reports) par ek jaisa.
- **Kapra:** lot = thaans ka jor; thaan ke hisse (40 m + 60 m); SO card edit baar baar; give-back + undo; fabric return aur SO card ek hi lot par; yards ek hi baar convert.
- **Concurrency:** 8 SO cards ek hi 100 m lot se ek waqt mein: bilkul 3 kamyab. Ek hi request 3 baar send: stock ek hi baar nikla. 20 khareed ek saath: stock bilkul unka jor. Numbering mein kabhi duplicate nahi.
- **Security:** company alag-alag (1,803 + 60+ valid hamle), jaali token, `alg:none` token, logout-all ke baad token, mass assignment, VIEW-only employee kuch nahi badal sakta, employee apni service se bahar nahi.
- **SQL injection:** har jagah jahan query mein text jora gaya hai, value ya to `escape` hoti hai, ya `Number()`, ya server ki apni uuid.
- **Passwords:** bcrypt 12 rounds, log mein kabhi nahi, error ek jaisa (email pata nahi chalti). `npm audit`: 0 vulnerabilities. Koi secret git mein nahi.
- **Audit log:** har badalne wali call ka record, aur database level par badla/mita nahi sakta.
- **Migrations:** sab 40 ulti bhi chalti hain aur dobara seedhi bhi.
- **Reports:** har SO card ka har meter kahin gina jata hai; paging, `all=true`, filters kabhi row gum ya double nahi karte.
- **Urdu/emoji:** naam aur search sab jagah theek (UTF8 par).

---

## 5. Aap se faisle chahiye (business)

1. **AUD-03:** kya process ho chuka (PROCESSING/COMPLETE) job reject hona chahiye? Meri raye: nahi.
2. **AUD-04:** Folding mein kitna gain/loss theek hai (jaise 5% tak)? Us se zyada par kya ho (rok dein ya approval)?
3. **AUD-05:** packing list ke meters Folding ke bheje hue se zyada ho sakte hain? Meri raye: nahi.
4. **AUD-06:** gate pass ke baad list hamesha band? Meri raye: haan.
5. **AUD-15:** store request se kitna zyada bhej sakta hai? (0%, ya chhota tolerance?)
6. **AUD-14:** kya poora system Pakistan ke waqt (Asia/Karachi) par chale?
7. **AUD-13:** packing list ka total = lines ka jor rakhein?
8. **AUD-12 / AUD-11:** SO card par "ab kahan hai" jobs se dikhayein? Purane `/so-cards/:id/send` aur `/accept` calls band karein?
9. **AUD-02:** paise exact decimal par le jayen?
10. **AUD-09:** kya employee ko sirf apne department ke SO cards ka raasta dikhna chahiye?

## 6. Mashwara: kis tarteeb se theek karein

1. **Pehle (go-live se pehle):** AUD-05, AUD-06, AUD-03, AUD-01, AUD-12 (+ AUD-11).
2. **Phir:** AUD-07 (tareekh), AUD-14 (time zone), AUD-13, AUD-08, AUD-15, AUD-04.
3. **Baad mein:** AUD-02, AUD-16, AUD-17, AUD-18 (indexes), AUD-19, AUD-20, AUD-21, AUD-09.

Zyada tar masle chhote hain (S = ek-do ghante ka kaam). Bare do AUD-12 (SO card ki jagah) aur AUD-01 (cost taqseem) hain.

## 7. Dobara chalane ka tareeqa

```bash
# aap ke asli database ke 37 hisaab ke rules (sirf parhta hai, kuch nahi badalta)
node scripts/audit-db.js

# saare audit tests (local test database chahiye: erp_test, UTF8)
npx jest tests/audit

# bada random costing test (zyada seeds aur qadam)
AUDIT_SEEDS=12 AUDIT_STEPS=160 npx jest tests/audit/costing-fuzz.test.js

# speed ka test (1,000 lots/cards/jobs, lagbhag 4 minute)
AUDIT_PERF=1 npx jest tests/audit/performance.test.js
```
Test database UTF8 mein banayen (warna Urdu ke tests ghalat fail honge):
`CREATE DATABASE erp_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`

Jab koi masla theek karein to uska `test.failing(...)` (file mein "KNOWN BUG AUD-xx" ke neeche) `test(...)` bana dein: agar masla sach mein theek hua hai to test pass hoga.

## 8. Is audit ki hadden (jo nahi dekha)

- Tests local Postgres par chalaye (wohi engine, UTF8), Supabase ke pooler par nahi. Asli database par sirf SELECT chalaye.
- Speed 1,000 jobs tak dekhi; 10,000+ par andaza hai, naapa nahi.
- Frontend, browser, nginx/server ki settings, backup, aur production `.env` mere samne nahi thay.
- Business ke rules (jaise Folding mein kitna gain theek) aap ke faislon par hain; main ne sirf jo kaam kar raha hai wo likha.
