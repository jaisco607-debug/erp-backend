# Textile ERP backend: project context (as of 2026-10-21)

Owner: Fahad Ayaz. Frontend is built by someone else (with an AI); this repo is the backend only. Future modules: accounts, payroll.
Stack: Node.js, Express 5, PostgreSQL (Supabase, Session pooler + SSL CA), Sequelize, Joi, plain JavaScript, MVC (routes, controllers, services, models, validators, middlewares). Security, audit log and request log everywhere. All URLs start with `/api/v1`. Tests: `jest --runInBand` (86 pass). Migrations: `npm run db:migrate` (39 so far, last `20261019000005-grey-return-card.js`).
Fahad's PC: `C:\Users\Texon\OneDrive\Documents\backend\erp-backend-step1\erp-backend`. He runs npm commands himself. Never put a password or `.env` anywhere.

## 1. Users, companies, access
- One login endpoint for everyone. Super admin: email + password + the shared super-admin code. Client admin and company users: company code (random XXXX-XXXX) + email + password. Same email may exist in different companies.
- Super admin creates companies and grants **services** to a company. The client admin grants a subset to his users, level **VIEW** or **FULL**. Revoking a service from a company removes it from its users. Strict per-company isolation. Every change is audited. No email service.
- Services (codes): GREY_STORE, SO_CARD, CHEMICAL_STORE, GENERAL_STORE, departments (kind PROCESS: Singeing, Dyeing, Dryer, Finishing, Stitching, Cutting, Printing, Stenter, Compacting ...; kind FOLDING; kind PACKING). Super admin can add more departments. New companies get the core modules and Packing automatically.

## 2. Grey store (fabric inward)
- Customers (code, name), qualities, colours. A **grey lot** = one arrival of cloth: lot no, type no (internal id), DC no (delivery challan), customer, quality, GLM/GSM, meters or yards, pieces (thaans). A lot can be entered thaan-wise (thaan no + meters) or meters-only. Approve locks it (only client admin un-approves). Soft deletes. Numbering API to continue the old system.
- **Give back** (`/grey-lots/:id/give-back`): the party takes cloth away unprocessed, no processing.
- **Fabric return grey** (`POST /grey-lots/fabric-return`): thaans the party wants back go straight to Folding on a special SO card (`isGreyReturn`), Folding can only pass them to Packing (no grading, `GREY_RETURN_ONLY_PACKING`), Packing makes the list and gate pass. The tag "Fabric return grey (not processed)" shows everywhere.

## 3. SO card (travel card)
- Made only when cloth is taken from lots of one party: thaan-wise (also part of a thaan: the rest stays free in grey) or meters. Fields: card no, ID#, date, quality, article/style, delivery date, description, instructions, work instructions. Per lot it remembers outBefore / balanceBefore. Conf. toggle locks it. Can be made and sent to a department in one call; `send-many` sends several NEW cards as one job. Edit lots/meters via `GET /so-cards/:id/edit-data`. Cancel only before sent.
- Guide: `docs/frontend/so-card-complete.md`.

## 4. Departments and jobs (cloth circulation)
- Every dispatch is a **Job#** (one job can hold several SO cards, each with lots/thaans/meters). Status flow: IN_WAY > (Receive) QUEUE > (Accept) PENDING > PROCESSING > COMPLETE, or REJECTED. Sent entries leave the sender's list but are kept.
- Reject (only cloth that came from another department, not from the SO card desk) needs a reason; the sender answers ACCEPT or DISPUTE. A disputed job returns to the rejector's Queue and cannot be rejected again.
- Receiving department types **operator name + process date** (editable until the cloth is sent on). Sending on needs both (`OPERATOR_REQUIRED`). Incoming rows carry `fromOperatorName`, `fromProcessDate`, `sentAt` and the full `trail`.
- Colour is set only by Dyeing, shown everywhere else. The send form takes `?jobId=` / `?soCardId=` and preselects that row. Cost is carried forward along the lineage (`sourceJobItemId`). Per-department URLs `/departments/<CODE>/...`.
- Guides: `department-flow-v2.md`, `department-operator-send.md`, `department-trail.md`.

## 5. Chemical store and costing
- Items in categories and brands, units with small units (3 KG 500 G), inwards (draft allowed when the rate is unknown, approve gives IP# and stock), vendors, GST. The Chemical Store decides which chemicals each department sees. Departments request chemicals for a Job (or one SO card): Queue > Process > In-Way > Delivered; not-in-stock handling (alternate chemical offer, ETA); returns by departments; stock adjustments (count, damaged, expired ...).
- **Batches (2026-10-19):** every approved purchase line is a batch with its own rate. Issue picks batches (or oldest first); cost per Job / SO card is by real rate (`byRate`); returns go back to their batch; usage record per batch / chemical (department, Job#, SO#, lots, thaans, meters); last 5 purchases on the inward screen. Guide: `chemical-batches.md`.
- Job and SO card cost = chemicals sent minus returned; Job lists show chemical count and cost per meter.

## 6. Folding (v3) and Packing
- **Folding:** per SO card inside a job, lot by lot, thaan by thaan: meters split into A / B / Cut Piece, diff = folded - received (shown only when fully graded or closed). Graded meters go to Packing with Send to Packing; the rest stays in Folding ("left in Folding"); `keepRemaining=false` closes the row (shrinkage). Grade boxes are per batch (what is not sent yet). Re-work: cloth sent back to a department through the normal send screen (tag RE-WORK, carried through all departments).
- **Packing:** receives only from Folding, only Receive / Accept. Packing list per SO card: lines lot / thaan / grade / meters, rates A / B / CP, Draft or Final, counter list no. A thaan can be on one list once per grade. PDF is made by the frontend.
- **Gate pass:** one per FINAL packing list: gate pass no, date, operator, driver, vehicle, destination, client, lots with thaan numbers only. Frontend prints 3 copies (Packing, Company guard, Driver); signature is frontend only.
- Guides: `folding-v3.md`, `packing-list.md`, `gate-pass.md`, `fabric-return-grey.md`.

## 7. Defaults I chose (Fahad can change)
Disputed rejection cannot be rejected again; grading only after Accept; Folding > Packing send does not need an operator; fabric-return cloth shows as grade A in Packing; mixed-party SO cards allowed in `send-many`; DRAFT chemical inward adds no stock until approved.

## 8. Where things are
- Cloud copy: `/mnt/project-files/erp-backend/`. Git: `/home/claude/erp-js` (84+ commits). API docs: `docs/API.md`, `docs/API-GUIDE.html`. Learning notes: `docs/samjhao/`. Frontend guides: `docs/frontend/*.md` (one per screen group).
- Work flow: change code, run tests, commit, copy to the cloud folder and to the PC, Fahad migrates and restarts.

## 9. Open items
- **Reports (done 2026-10-21):** 15 read-only reports under `/reports/...` (grey parties and lots, SO cards, movement, one SO card, departments, department jobs, operators, chemical usage / stock / purchases, Folding, cloth now, packing lists, gate passes). One answer shape; the frontend makes PDF (jsPDF) and Excel (SheetJS) from `?export=true`. Guide: `docs/frontend/reports.md`. 87 tests pass. Files are in the cloud folder; the PC copy is pending (device was offline).
- General Store issue to departments, low-stock alert. Later: accounts, payroll.
