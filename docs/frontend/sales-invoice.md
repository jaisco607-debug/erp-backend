# Sales Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Read section 1 first; it explains the idea in plain words.

## 1. The idea in plain words

- A **Sales Invoice** is a bill to **one customer** ("Billed to"): the customer whose cloth we processed.
- The invoice is made of **gate passes**. Every gate pass already has a packing list, and the packing list already has the meters of A, B and CP and the rate of each. So the user does **not type quantities or rates**. He picks the gate passes, and the server fills the lines.
- Different gate passes of the same customer can go to different places ("Delivered to" = the destination written on the gate pass). They can all be on one invoice, or the user can pick only some of them.
- A gate pass can be on **one invoice only**.
- **Two steps:**
  1. **Save** makes the invoice **Un-approved** (a draft). It can be changed or deleted. It has **no effect on the accounts**.
  2. **Approve** posts the **accounting entry** (journal): the money is recorded in the books. After this the invoice is **locked**.
- To change an approved invoice: **Un-approve** it (the server posts a reverse entry, nothing is erased), change it, **Approve** again.
- **The accounts entry** (the "Accounts" button) shows the entry of the invoice. It always balances: Debit = Credit.

The accounting entry made on Approve (example from the real screens: 143,200 + 18 % tax):

| Account | Debit | Credit |
|---|---|---|
| Accounts Receivable | 168,976 | |
| Sales | | 143,200 |
| Output Sales Tax | | 25,776 |
| **Total** | **168,976** | **168,976** |

The three accounts are found by the server in the Chart of Accounts. If the company does not have them yet, the server **makes them when the first invoice is saved** (Accounts Receivable, Sales and Output Sales Tax, as locked system accounts, with the folders above them). A company's own account of the same name is used instead of a new one. The accounts appear in the Chart of Accounts at once, but a draft posts nothing to them (their balances stay zero until an invoice is approved). The frontend does nothing for this; after the first Save, reload the Chart of Accounts if it is open. See `chart-of-accounts.md`, section 13.

**Checking the books:** after every approve / un-approve, open the Trial Balance (see `trial-balance.md`). It must show debit = credit, and its "checks" confirm that every approved invoice agrees with the ledger and that Accounts Receivable agrees with what the customers owe.

## 2. Access

- New service **`ACC_SALES`** ("Sales Invoice"), menu tab **`ACCOUNTS`** (the same tab as Chart of Accounts).
- The super admin gives it to a company; the client admin gives it to employees as VIEW or FULL.
- VIEW: list, open an invoice, see the accounts entry. FULL: also create, edit, delete, approve, un-approve.
- Without the service every call answers `403 FORBIDDEN`. Another company's data is never visible (`404`).
- Show the menu item only when the login response `services` list contains `ACC_SALES`.

Base path: `/api/v1/sales-invoices`.

## 3. The invoice object

```json
{
  "id": "uuid",
  "voucherNo": 1623, "voucherLabel": "01623",
  "invoiceNo": 2748, "invoiceLabel": "02748",
  "invoiceDate": "2026-09-30",
  "customer": { "id": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2", "address": null, "city": "Karachi" },
  "notes": "SMELL BLACK 31583/628", "invoiceDetails": "SMELL BLACK 31583/628", "hsCode": "5208.1100",
  "taxRate": 18,
  "qty": 12962, "gross": 518480, "tax": 93326.4, "net": 611806.4, "received": 0, "balance": 611806.4,
  "status": "UNAPPROVED", "statusText": "Un-approved",
  "approvedAt": null, "approvedBy": null,
  "canEdit": true, "canDelete": true, "canApprove": true, "canUnapprove": false,
  "fbrStatus": null,
  "lines": [ ...see section 4... ]
}
```

| Field | Meaning |
|---|---|
| `voucherNo` | The internal voucher number ("Voucher ID" on the screen). Given by the server, never typed. |
| `invoiceNo` | The invoice number printed on the invoice. Left empty, the server gives the next number. The user may type one to continue his old numbering. Unique per company. |
| `*Label` | The same number with leading zeros (`02748`). Show these. |
| `qty` | Billed quantity (meters) of the whole invoice. |
| `gross` | Amount before tax (sum of the lines). |
| `taxRate` / `tax` | Sales tax percentage (default 18) and its amount: `gross x taxRate / 100`, rounded to 2 decimals. |
| `net` | `gross + tax`. This is what the customer owes. |
| `received` / `balance` | Money received so far (always 0 for now; payments come in a later step) and `net - received`. |
| `status` | `UNAPPROVED` or `APPROVED`. |
| `canEdit`, `canDelete`, `canApprove`, `canUnapprove` | Use these to show or hide buttons. Do not work them out yourself. |
| `fbrStatus` | Always `null` for now. The FBR / Billora upload comes later. Keep the "Upload FBR" button disabled. |

`notes`, `invoiceDetails` and `hsCode` are free text (max 300 / 300 / 20). `hsCode` defaults to `5208.1100`.

All money values are plain JSON numbers with at most 2 decimals. Show them as received (format with thousands separators only). Do not add or multiply them in the browser.

## 4. The lines (one per gate pass)

```json
{
  "lineNo": 1,
  "gatePassId": "uuid", "gatePassNo": 515, "gatePassLabel": "00515", "passDate": "2026-10-08",
  "packingListId": "uuid", "listNo": 12, "soCardId": "uuid", "soLabel": "SO 4871",
  "dcNo": "3105", "quality": "10X7/72X30 BLACK SMELL FABRIC", "colour": "BLACK",
  "deliveredTo": "Lahore", "vehicleNo": "LEA-1234",
  "qtyA": 12962, "qtyB": 235, "qtyCP": 70, "totalQty": 13267,
  "billedQty": 12962, "rateA": 40, "rateB": 0, "rateCP": 0, "amount": 518480
}
```

- This matches the table of the screens: SR (gate pass no), DC#, SO, DATE, QUALITY, COLOUR, DELIVERED TO, A, B, CP, TOTAL, BILLED QTY, RATE, AMOUNT. There is no PO in our data, so leave that column out.
- **Billed qty = the meters of the grades that have a rate.** In the example only grade A has a rate (40), so the B and CP meters are shown but not billed. If a list has rates for A and B, both are billed. `amount = sum over the grades of (meters x rate)`, rounded to 2 decimals per packing line, exactly as on the packing list.
- If `rateA`, `rateB` and `rateCP` are different, show the three rates (or "A 50 / B 25"). If only one grade is billed, show that rate.
- The numbers of an invoice are saved on the invoice. Only the descriptions (quality, colour, deliveredTo ...) are read from the gate pass.
- Lines are read only. The user changes them only by choosing other gate passes.

## 5. Endpoints

### GET `/sales-invoices/options`
```json
{ "statuses": [{ "code": "UNAPPROVED", "text": "Un-approved" }, { "code": "APPROVED", "text": "Approved" }],
  "taxRates": [0, 5, 10, 15, 18], "defaultTaxRate": 18, "defaultHsCode": "5208.1100" }
```
`taxRates` are only suggestions for the Sales Tax dropdown. Any number from 0 to 100 (2 decimals) is accepted.

### GET `/sales-invoices/gate-passes?customerId=...`  (the "Select packing list" dropdown)
The gate passes the user may still put on an invoice: of this customer, not yet on any invoice. Query: `customerId` (required), `destination` (optional, exact venue name, not case sensitive), `search` (gate pass no, packing list no, SO no, destination or vehicle), `invoiceId` (when **editing**, so that the gate passes of this invoice stay in the list), `limit` (default 200).

```json
{ "data": [ { ...line fields (section 4) without lineNo..., "canBill": true, "blockedReason": null } ],
  "total": 2, "destinations": ["Karachi", "Lahore"] }
```
- `destinations` = the venues of the available gate passes (before the `destination` filter). Use it for a "Delivered to" filter dropdown: the user can pick all gate passes of one venue, or tick gate passes of several venues.
- Fabric returns (cloth that was not processed) are never offered.
- `canBill: false` (with `blockedReason`) means the packing list has no rates. Show it greyed out; the server refuses it anyway.

Flow of the form: pick the customer, then call this endpoint, then the user ticks one or more gate passes. Changing the customer clears the ticked gate passes.

### GET `/sales-invoices`  (the Sales Invoices list / summary)
Query (all optional): `status` (`APPROVED` | `UNAPPROVED`; leave out for all), `dateFrom`, `dateTo` (YYYY-MM-DD), `customerId`, `search` (invoice no, voucher no, customer name, NTN, HS code, details, notes), `page` (default 1), `limit` (default 50, max 500).
```json
{ "data": [ { ...invoice without lines... } ], "page": 1, "limit": 50, "total": 50,
  "summary": { "invoices": 50, "amount": 43420343, "tax": 7815662, "net": 51236005, "received": 17215008, "balance": 34020997 } }
```
- `summary` is for **all** invoices that match the filters (not just this page). It gives the six cards at the top: INVOICES, AMOUNT (= gross), SALES TAX, NET AMOUNT, RECEIVED, BALANCE.
- Newest invoice number first.

### GET `/sales-invoices/:id`
One invoice with `lines`.

### POST `/sales-invoices`  (Save, makes an Un-approved invoice)
```json
{ "customerId": "uuid", "gatePassIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24",
  "invoiceNo": 2749, "notes": "...", "invoiceDetails": "...", "hsCode": "5208.1100", "taxRate": 18 }
```
- Required: `customerId`, `gatePassIds` (at least one). Everything else is optional (`invoiceDate` = today, `invoiceNo` = next number, `taxRate` = 18).
- Returns `201` with the invoice (with lines). The amounts in the response are the final ones; show them.

### PATCH `/sales-invoices/:id`  (Update, only while Un-approved)
Send only what changed. Any of: `gatePassIds` (replaces the lines), `taxRate`, `invoiceDate`, `invoiceNo`, `notes`, `invoiceDetails`, `hsCode`, `customerId` (then `gatePassIds` of the new customer are required). The amounts are always worked out again by the server. Returns `200` with the invoice.

### DELETE `/sales-invoices/:id`
Only while Un-approved. `204`. Its gate passes become free again.

### POST `/sales-invoices/:id/approve`  (no body)
Posts the accounting entry. Returns `200` with the invoice (`status: APPROVED`). The amounts are worked out once more from the gate passes before posting.

### POST `/sales-invoices/:id/unapprove`  (optional body `{ "reason": "wrong rate" }`)
Posts the reverse entry and returns the invoice to `UNAPPROVED`. Not possible after money was received (later step). Returns `200` with the invoice.

### GET `/sales-invoices/:id/accounts-entry`  (the "Accounts" button)
```json
{
  "invoiceId": "uuid", "invoiceLabel": "01620", "status": "APPROVED", "posted": true,
  "current": {
    "entryNo": 41, "entryDate": "2026-09-30", "status": "POSTED", "narration": "Sales invoice 01620 - HAMID ENTERPRISES",
    "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "1003", "name": "Accounts Receivable" }, "debit": 168976, "credit": 0, "partyType": "CUSTOMER", "partyId": "uuid" },
               { "lineNo": 2, "account": { "code": "4001", "name": "Sales" }, "debit": 0, "credit": 143200 },
               { "lineNo": 3, "account": { "code": "1010", "name": "Output Sales Tax" }, "debit": 0, "credit": 25776 } ],
    "totals": { "debit": 168976, "credit": 168976 }, "balanced": true
  },
  "entries": [ ...every entry of this invoice, oldest first (see below)... ]
}
```
- Show `current` in the "Accounts entry" popup (title "Accounts entry", subtitle "Posted to the ledger"): the table Account / Debit / Credit, the Total row, and the green line "Debit equals credit." when `balanced` is true.
- `current` is `null` and `posted` is `false` while the invoice is Un-approved. Then show "Not posted yet. Approve the invoice to post it to the ledger."
- `entries` is the full history: after an un-approve you see the first entry (`status: REVERSED`) and the reverse entry (`reversalOfId` set). Optional: show it under "History".

## 6. Rules and errors

Errors look like `{ "error": { "code", "message", "details?" } }`. `400 VALIDATION_FAILED` is a bad value. The codes below are `422` unless written otherwise. Show `message` to the user.

| code | When |
|---|---|
| `GATE_PASS_OTHER_CUSTOMER` | A chosen gate pass belongs to another customer. |
| `GATE_PASS_TAKEN` | The gate pass is already on another invoice (the message names it). |
| `GREY_RETURN_NOT_SOLD` | Fabric return cloth is not sold. |
| `NO_RATES` | The packing list of the gate pass has no rates, so there is nothing to bill. |
| `GATE_PASSES_REQUIRED` | The customer was changed without choosing gate passes. |
| `INVOICE_NO_TAKEN` | The typed invoice number is already used. |
| `INVOICE_APPROVED` | An approved invoice cannot be edited or deleted. Un-approve it first. |
| `ALREADY_APPROVED` / `NOT_APPROVED` | Approve on an approved invoice / un-approve on one that is not approved. |
| `NOTHING_TO_BILL` | The invoice amount is zero. |
| `HAS_RECEIPTS` | Money was received against the invoice; it cannot be un-approved. |
| `DEFAULT_ACCOUNT_INACTIVE` | One of the default accounts (Accounts Receivable, Sales, Output Sales Tax) was switched off in the Chart of Accounts. The message names it. Ask the user to switch it on. |
| `PARENT_INACTIVE` | While making a missing default account: a header it must sit in is switched off (the message names it). |
| `NOT_FOUND` (404) | The invoice, customer or gate pass does not exist in this company. |
| `FORBIDDEN` (403) | No `ACC_SALES` service, or VIEW only. |

## 7. What to build

1. **Sales Invoices screen** (list): the six summary cards, the filters (Show: All / Approved / Un-approved, Period or dates, Search, Apply, Clear), the table (Invoice, ID = voucher, Date, Customer + invoice details in grey, Qty, Amount, Tax, Net, Received), and the "New invoice" and "Export" buttons. Clicking a row opens the invoice. Export can be done in the browser from the loaded list.
2. **Invoice form** (new and open): header with status badge (Un-approved / Approved) and the buttons from `canEdit`, `canApprove`, `canUnapprove`, `canDelete`. Fields: Billed to (customer picker), NTN / Address (read only from `customer`), Invoice # (empty = automatic), Date, Notes, Invoice details, HS Code, FBR status (disabled for now). The "Sales details" tab holds the lines table and **Select packing list** (the gate pass dropdown described above). The totals bar shows GROSS, SALES TAX (with the rate dropdown), NET, RECEIVED, BALANCE. The **Payments** tab is empty for now (receipts come in a later step).
3. **Buttons:** Save (new) / Update (edit) ; Approve ; Un-approve (ask for an optional reason) ; Delete (confirm) ; Accounts (opens the popup) ; Print (the frontend makes the print layout) ; Upload FBR (disabled) ; Close.
4. After every Save, Update, Approve or Un-approve, replace the whole screen with the invoice returned by the server.
5. Totals shown while the user is still choosing gate passes (before Save) may be worked out in the browser from the gate pass `amount` values and the tax rate for display only. The server's numbers after Save are the real ones.

## 8. Notes

- **Dates:** `invoiceDate` is a plain date `YYYY-MM-DD`. The books use the invoice date.
- **One invoice, one customer.** If the user needs two customers, he makes two invoices.
- **Nothing is deleted from the books.** Un-approve posts a reverse entry; the Chart of Accounts shows the account balances only through entries, never through the invoice.
- Payments (Receipt Voucher), FBR upload and purchase invoices come in later steps. Keep their buttons visible but disabled where the screens show them.
