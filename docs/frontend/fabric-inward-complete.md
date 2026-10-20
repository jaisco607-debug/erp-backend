# FABRIC (GREY) INWARD: complete frontend guide
Build the full Fabric Inward module from this guide. It replaces all earlier grey inward guides.

## What is new in this version
- **GLM** and **GSM** fields on the grey lot (optional numbers). See sections 3, 4 and 6.
  - Show them as two number inputs next to each other, after the Unit toggle.
  - Empty input: do not send the field (or send `null` on edit to clear it). `glm` and `gsm` are null when not entered; show "-".

## 0. Basics
- Base URL `/api/v1`. Every call sends the header `Authorization: Bearer <token>`.
- Errors come as `{ "error": { "code": "...", "message": "..." } }`. Show `message` in a toast. 400 VALIDATION_FAILED means a field is wrong.
- Access: the user needs the **GREY_STORE** service.
  - **VIEW** users only see lists and details. Hide the Add, Edit, Approve, Return and Delete buttons.
  - **FULL** users can do everything below.
  - "Client admin only" items need `userType === "CLIENT_ADMIN"`.
- The UI must be simple: dropdowns, toggles and checkboxes; as little typing as possible.
- Menu under "Fabric Inward": **Parties (Customers)**, **Qualities**, **Grey Lots**.

## 1. Parties (customers)
- GET `/customers?search=&isActive=true&page=1&limit=100` returns the list.
- POST `/customers` with `{ "name": "Waqas Textile", "phone": "", "address": "", "code": 15 }`. `code` is optional; the server gives one if it is empty.
- GET `/customers/:id`
- PATCH `/customers/:id` with `{ name?, phone?, address?, isActive? }`
- DELETE `/customers/:id` (soft delete)
- Screen: a table (Code, Name, Phone, Active toggle) and an Add/Edit modal.
- Errors: `NAME_TAKEN`, `CODE_TAKEN`.

## 2. Qualities
- GET `/qualities?search=&isActive=true`
- POST `/qualities` with `{ "name": "PC TWILL" }`
- PATCH `/qualities/:id` with `{ name?, isActive? }`
- DELETE `/qualities/:id`
- Screen: a table (Name, Active toggle) and an Add/Edit modal. Error: `NAME_TAKEN`.
- New qualities can also be created by typing a new name in the lot form (section 3).

## 3. Grey Lot: new lot form
### Fields
| Field | Input | Notes |
|---|---|---|
| Lot# | number input | Placeholder is the next automatic number from `GET /grey-lots/numbering` (`nextLotNo`). Leave it empty for automatic; a typed number must be unused (`LOT_NO_TAKEN`). |
| Inward date | date picker | Required. Defaults to today. Format `YYYY-MM-DD`. |
| Party | dropdown | Required. `GET /customers?isActive=true`. Send `customerId`. |
| Quality | combo box (search + free text) | Picked from `GET /qualities?isActive=true`: send `qualityId`. Typed a new name: send `qualityName` and the server creates it. Send exactly ONE of the two. |
| DC# | text | Delivery challan no. |
| Unit | toggle METER / YARD | Default **METER**. Use YARD only when the party sends yards. |
| Thaans | table | One row per thaan; see below. |
| GLM | number input (2 decimals) | Optional. Grams per linear meter, e.g. 145.5. Send `glm`. |
| GSM | number input (2 decimals) | Optional. Grams per square meter, e.g. 120. Send `gsm`. |
| Party ref | text | Optional. Links split deliveries. |
| Vehicle no | text | Optional. |
| Remarks | text area | Optional. |
| Re-process | toggle | Optional. When on, a dropdown "Re-process of lot" (`GET /grey-lots`) sends `reprocessOfLotId`. |

### Thaan table
- Each thaan is saved separately with its own length; the thaans are not merged.
- Columns: Thaan# (automatic 1, 2, 3 ...) and Length (in the chosen unit).
  - For YARD only, add a read-only Meters column (yards × 0.9144, 2 decimals).
  - For METER, show no yards anywhere.
- Buttons: "+ Add thaan" and a remove icon on each row. Pressing Enter in a Length cell adds a new row and focuses it.
- Footer: total thaans and total meters (plus total yards for YARD only).

### Save
POST `/grey-lots`
```json
{ "lotNo": 2437, "inwardDate": "2026-10-15", "customerId": "…", "qualityId": "…",
  "dcNo": "552", "unit": "METER", "thaans": [52.5, 48, 50.25], "glm": 145.5, "gsm": 120,
  "partyRef": "", "vehicleNo": "LES-1234", "remarks": "" }
```
- Do not send `pieces` or `inwardMeters`; the server counts them from the thaans.
- Old way (no thaan list, total only): `"inwardMeters": 1000, "pieces": 10`, or for YARD `"inwardYards": 1093.6, "pieces": 10`.
- Errors:
  - `QTY_REQUIRED`: no thaans and no total
  - `LOT_NO_TAKEN`: that Lot# is already used
  - `UNKNOWN_CUSTOMER`, `CUSTOMER_INACTIVE`: party problem
  - `UNKNOWN_QUALITY`, `QUALITY_INACTIVE`: quality problem
- On success, go to the lot detail.

## 4. Grey Lots list
GET `/grey-lots?search=&customerId=&qualityId=&isApproved=&isActive=&isReprocess=&dateFrom=&dateTo=&page=1&limit=100`
- Filters on top: Party dropdown, Quality dropdown, Approved (All/Yes/No), Active (All/Yes/No), date from/to, and a search box (Lot#, Type#, DC#).
- Columns: Lot#, Type#, Date, Party, Quality, GLM, GSM, Unit, Thaans, Inward, Balance, Returned (thaans / m), Approved badge, Active toggle.
- Every lot has these fields:
```json
{ "id": "…", "lotNo": 2437, "typeNo": "0612", "dcNo": "552", "inwardDate": "2026-10-15",
  "glm": 145.5, "gsm": 120,
  "unit": "METER", "showYards": false, "pieces": 3,
  "inwardMeters": 150.75, "inwardYards": null,
  "outwardMeters": 0, "soCardMeters": 0, "balanceMeters": 150.75, "balanceYards": null,
  "returnedMeters": 0, "returnedYards": null, "returnedPieces": 0,
  "isApproved": false, "isActive": true, "isReprocess": false,
  "customer": { "id": "…", "name": "…" }, "quality": { "id": "…", "name": "PC TWILL" } }
```
- **Yards:** show yards only when `showYards` is true (YARD lots), e.g. `274.32 m / 300 yd`. For METER lots all yards fields are null.
- `soCardMeters` is the cloth that went on SO cards; `returnedMeters` is the cloth given back to the party; `balanceMeters` is what is left in stock.

## 5. Lot detail page
GET `/grey-lots/:id` returns the lot plus `thaans` and `returns`:
```json
"thaans": [ { "id": "…", "thaanNo": 1, "meters": 52.5, "yards": null, "status": "IN_STOCK", "takenMeters": 0, "freeMeters": 52.5 } ],
"returns": [ { "id": "…", "returnNo": 1, "returnDate": "2026-10-15", "pieces": 2, "meters": 98.25, "yards": null, "vehicleNo": "LES-1", "remarks": null } ]
```
- Top: the lot info cards (as in the list).
- Thaan table: Thaan#, Length, Status, On SO card (`takenMeters`), Free (`freeMeters`). Status values:
  - `IN_STOCK`: free; it may be partly on an SO card
  - `SO_CARD`: all of it is on SO cards
  - `RETURNED`: given back
  Grey out RETURNED rows.
- A thaan with `takenMeters > 0` cannot be given back or have its length edited (`THAAN_ON_SO_CARD`).
- Returns table (section 7c).
- Buttons, depending on rights and state:
  - **Edit**: FULL access and `isApproved` false.
  - **Approve**: FULL access and not approved. Calls POST `/grey-lots/:id/approve`. Only approved lots can go on an SO card.
  - **Un-approve**: client admin only, when approved. Calls POST `/grey-lots/:id/unapprove`.
  - **Return to party**: FULL access and `balanceMeters > 0`.
  - **Active toggle**: PUT `/grey-lots/:id/active` with `{ "isActive": false }`. An inactive lot is hidden from the SO card dropdown.
  - **Delete**: only when not approved and nothing has gone out. Calls DELETE `/grey-lots/:id`. Errors `LOT_APPROVED`, `LOT_IN_USE`.

## 6. Edit lot (everything is editable)
- PATCH `/grey-lots/:id`. Reuse the new-lot form filled from the detail, and send only the changed fields.
- Editable fields: `lotNo`, `typeNo`, `dcNo`, `inwardDate`, `customerId`, `qualityId` or `qualityName`, `glm`, `gsm`, `unit`, `thaans` (send the WHOLE list again), `inwardMeters`/`inwardYards` + `pieces`, `partyRef`, `vehicleNo`, `remarks`, `isReprocess`, `reprocessOfLotId`.
- Type# is editable only here (on create it is automatic).
- Rules:
  - An approved lot is locked (`LOT_APPROVED`). The client admin un-approves, the user edits, then the lot is approved again.
  - RETURNED thaan rows are locked in the form; changing or removing them gives `THAAN_RETURNED`.
  - The total cannot go below what is on SO cards (`BELOW_OUTWARD`).
  - The party cannot change after cloth went on an SO card (`LOT_IN_USE`).
  - `LOT_NO_TAKEN`, `TYPE_NO_TAKEN`: that number is already used.

## 7. Return to party (cloth given back unprocessed)
Case: the party sent grey cloth, then asks for some or all of it back without processing.

### 7a. Return screen (modal)
- Header: Lot#, Party, Quality, Balance.
- Thaan checklist: one checkbox per thaan (Thaan#, Length). Only `IN_STOCK` rows can be ticked; RETURNED rows are greyed out with the label "Returned".
- Add a "Select all" checkbox and a live line: "Selected: 3 thaans / 150.75 m".
- Old lot with no thaans (`thaans` empty): show Meters and Pieces inputs instead of the checklist.
- Fields: Return date (default today), Vehicle no, Remarks.
- Before saving, ask: "Return 3 thaans (150.75 m) to <party>?"

### 7b. Save
POST `/grey-lots/:id/give-back`
```json
{ "thaanNos": [51, 52, 53], "returnDate": "2026-10-15", "vehicleNo": "LES-1", "remarks": "party asked" }
```
For an old lot with no thaans:
```json
{ "meters": 400, "pieces": 4, "returnDate": "2026-10-15" }
```
- The response is the updated lot; refresh the page with it.
- Errors:
  - `THAAN_RETURNED`: already returned
  - `UNKNOWN_THAAN`: wrong thaan number
  - `PICK_THAANS`: the lot has thaans, so tick them
  - `NOT_ENOUGH_METERS`: more than the balance

### 7c. Returns section on the detail page
- Columns: Return#, Date, Thaans, Meters (yards for YARD lots), Vehicle, Remarks.
- Client admin only: an "Undo" button with a confirmation. It calls DELETE `/grey-lots/:id/give-back/:returnId`; the response is the updated lot and the thaans become IN_STOCK again.
- Returned cloth cannot go on an SO card.
- Its print and gate pass come later with the Packing List; do not build them now.

## 8. Numbering settings (client admin only)
- GET `/grey-lots/numbering` returns `{ "nextLotNo": 2438, "nextTypeNo": 613 }`.
- PUT `/grey-lots/numbering` with `{ "nextLotNo": 3000, "nextTypeNo": 700 }` sets where the automatic numbers continue (to carry on from the old system). Error `NUMBER_USED` if that number already exists.
- Screen: a small settings card with two number inputs and Save.
