# Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). It is the mirror of the Sales Invoice (`sales-invoice.md`): read that first if you can, most things work the same way. Read section 1 here first; it explains the idea in plain words.

## 1. The idea in plain words

- A **Purchase Invoice** is the **bill of one vendor** (supplier): what we bought from him and now **owe** him. (A Sales Invoice is the opposite: what a customer owes us.)
- It is made of the vendor's **purchases from the store**: the approved entries of the **Chemical Store** and the **General Store** (each of them has a vendor, the items and the amount; a Chemical Store purchase on a GST bill also carries the sales tax; a General Store purchase never carries sales tax). The user does **not type amounts**. He picks the vendor, ticks the store purchases the bill is for, and the server fills the lines.
- A store purchase can be on **one purchase invoice only**.
- **Two steps:**
  1. **Save** makes the invoice **Un-approved** (a draft). It can be changed or deleted. It has **no effect on the accounts**.
  2. **Approve** posts the **accounting entry**: the debt to the vendor is recorded in the books. After this the invoice is **locked**.
- To change an approved invoice: **Un-approve** it (the server posts a reverse entry, nothing is erased), change it, **Approve** again.
- **The accounts entry** (the "Accounts" button) shows the entry of the invoice. It always balances: Debit = Credit.

The accounting entry made on Approve (example: purchases of 5,700 and sales tax of 990):

| Account | Debit | Credit |
|---|---|---|
| Purchases | 5,700 | |
| Input Sales Tax | 990 | |
| Accounts Payable (the vendor is named on the line) | | 6,690 |
| **Total** | **6,690** | **6,690** |

In plain words: the purchases are a cost (Purchases); the sales tax the vendor charged us can be claimed back from the government (Input Sales Tax, an asset); and we now owe the vendor 6,690 (Accounts Payable).

The three accounts are found by the server in the Chart of Accounts. If the company does not have them yet, the server **makes them when the first purchase invoice is saved**: Purchases (in the folder Cost of Sales), Input Sales Tax (in Assets / Current Assets) and Accounts Payable (in Liabilities / Current Liabilities), as locked system accounts. A company's own account of the same name is used instead of a new one. A draft posts nothing to them (balances stay zero until an invoice is approved). The frontend does nothing for this; after the first Save, reload the Chart of Accounts if it is open.

**Checking the books:** after every approve / un-approve, open the Trial Balance (`trial-balance.md`). It must show debit = credit; its checks confirm that every approved purchase invoice agrees with the ledger, and that Accounts Payable agrees with what we owe each vendor.

**A purchase that is on an invoice is locked in the store.** While a store purchase is on a purchase invoice (draft or approved), the store screens cannot "Correct" or "Un-approve" it: the server answers `ENTRY_ON_PURCHASE_INVOICE` (section 6). Show that message in the store screens. To change the purchase, the invoice is un-approved (if needed) or deleted first; when the invoice is saved or approved again it takes the new amounts.

## 2. Access

- New service **`ACC_PURCHASES`** ("Purchase Invoice"), menu tab **`ACCOUNTS`** (with Chart of Accounts and Sales Invoice).
- The super admin gives it to a company; the client admin gives it to employees as VIEW or FULL.
- VIEW: list, open an invoice, see the accounts entry. FULL: also create, edit, delete, approve, un-approve.
- Without the service every call answers `403 FORBIDDEN`. Another company's data is never visible (`404`).
- Show the menu item only when the login response `services` list contains `ACC_PURCHASES`.

Base path: `/api/v1/purchase-invoices`.

## 3. The invoice object

```json
{
  "id": "uuid",
  "voucherNo": 12, "voucherLabel": "00012",
  "billNo": "S-SES2358",
  "invoiceDate": "2026-10-24", "dueDate": "2026-11-23",
  "vendor": { "id": "uuid", "code": 7, "name": "NEXUS CHEMICAL", "ntn": "1234567-8", "address": null, "city": "Karachi" },
  "notes": "October chemicals", "billDetails": null,
  "inwardCount": 3,
  "gross": 5700, "tax": 990, "net": 6690, "paid": 0, "balance": 6690,
  "status": "UNAPPROVED", "statusText": "Un-approved",
  "approvedAt": null, "approvedBy": null,
  "canEdit": true, "canDelete": true, "canApprove": true, "canUnapprove": false,
  "lines": [ "...see section 4..." ]
}
```

| Field | Meaning |
|---|---|
| `voucherNo` | Our own number of the invoice ("Voucher ID"). Given by the server, never typed. |
| `billNo` | The number printed on the **vendor's own bill** (text, optional, max 50). A vendor's bill number can be entered only once (not case sensitive): a second time answers `BILL_NO_TAKEN`. Two different vendors may have the same number. |
| `invoiceDate`, `dueDate` | The bill date (default today) and the day it must be paid (optional, not before the bill date). The books use `invoiceDate`. |
| `inwardCount` | How many store purchases are on the invoice. |
| `gross` | The purchases without tax (sum of the lines). |
| `tax` | The sales tax of the purchases (sum of the lines). There is no tax rate to choose: the tax is what the store purchases carry. |
| `net` | `gross + tax`: what we owe the vendor. |
| `paid`, `balance` | Money paid to the vendor so far (always 0 for now; payments come in a later step) and `net - paid`. |
| `status` | `UNAPPROVED` or `APPROVED`. |
| `canEdit`, `canDelete`, `canApprove`, `canUnapprove` | Use these to show or hide buttons. Do not work them out yourself. |

All money values are plain JSON numbers with at most 2 decimals. Show them as received (format with thousands separators only). Do not add or multiply them in the browser.

## 4. The lines (one per store purchase)

```json
{
  "lineNo": 1,
  "inwardId": "uuid", "store": "CHEMICAL", "storeText": "Chemical Store",
  "idNo": 909, "idLabel": "00909", "ipNo": 805, "ipLabel": "00805",
  "inwardDate": "2026-10-10", "billType": "GST", "grnNo": "G-55", "dcNo": "DC-1", "notes": null,
  "items": "Caustic Soda, Acetic Acid", "gstPercent": 18,
  "amount": 5000, "salesTax": 900, "net": 5900
}
```

- `store` / `storeText` say which store it came from. `idNo` / `ipNo` are the numbers shown in the store screens (ID# and IP#).
- `items` is the names of the items bought, for display.
- `amount` and `salesTax` are the numbers **saved on the invoice**. The descriptions are read from the store entry.
- Lines are read only. The user changes them only by choosing other purchases.

## 5. Endpoints

### GET `/purchase-invoices/options`
`{ "statuses": [ { "code": "UNAPPROVED", "text": "Un-approved" }, { "code": "APPROVED", "text": "Approved" } ], "stores": [ { "code": "CHEMICAL", "text": "Chemical Store" }, { "code": "GENERAL", "text": "General Store" } ] }`

### GET `/purchase-invoices/inwards?vendorId=...`  (the "Select purchases" list)
The approved store purchases of this vendor that can still be put on an invoice. Query: `vendorId` (required), `store` (`CHEMICAL` or `GENERAL`, optional), `search` (ID#, IP#, GRN, DC, notes or item name), `invoiceId` (when **editing**, so that the purchases of this invoice stay in the list), `limit` (default 200).
```json
{ "data": [ { "...line fields (section 4) without lineNo...": "", "canBill": true, "blockedReason": null } ], "total": 3 }
```
- Draft (not approved) store purchases are never listed: the store must approve them first.
- `canBill: false` (with `blockedReason`) means the purchase has no amount. Show it greyed out; the server refuses it anyway.

Flow of the form: pick the vendor, then call this endpoint, then the user ticks one or more purchases. Changing the vendor clears the ticked purchases.

### GET `/purchase-invoices`  (the list / summary)
Query (all optional): `status` (`APPROVED` | `UNAPPROVED`; leave out for all), `dateFrom`, `dateTo` (YYYY-MM-DD), `vendorId`, `search` (voucher no, vendor name, NTN, vendor's bill no, details, notes), `page` (default 1), `limit` (default 50, max 500).
```json
{ "data": [ { "...invoice without lines...": "" } ], "page": 1, "limit": 50, "total": 12,
  "summary": { "invoices": 12, "amount": 1500000, "tax": 120000, "net": 1620000, "paid": 0, "balance": 1620000 } }
```
- `summary` is for **all** invoices that match the filters (not just this page): the cards INVOICES, AMOUNT (= gross), SALES TAX, NET AMOUNT, PAID, BALANCE (what we still owe).
- Newest voucher number first.

### GET `/purchase-invoices/:id`
One invoice with `lines`.

### POST `/purchase-invoices`  (Save, makes an Un-approved invoice)
```json
{ "vendorId": "uuid", "inwardIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24", "dueDate": "2026-11-23",
  "billNo": "S-SES2358", "notes": "...", "billDetails": "..." }
```
- Required: `vendorId`, `inwardIds` (at least one). Everything else is optional.
- Returns `201` with the invoice (with lines). The amounts in the response are the final ones.
- The first Save in a company also makes the default accounts (section 1).

### PATCH `/purchase-invoices/:id`  (Update, only while Un-approved)
Send only what changed. Any of: `inwardIds` (replaces the lines), `invoiceDate`, `dueDate` (send `null` to clear), `billNo`, `notes`, `billDetails`, `vendorId` (then `inwardIds` of the new vendor are required). The amounts are always worked out again by the server. Returns `200` with the invoice.

### DELETE `/purchase-invoices/:id`
Only while Un-approved. `204`. Its store purchases become free again.

### POST `/purchase-invoices/:id/approve`  (no body)
Posts the accounting entry. Returns `200` with the invoice (`status: APPROVED`). The amounts are worked out once more from the store purchases before posting.

### POST `/purchase-invoices/:id/unapprove`  (optional body `{ "reason": "wrong bill" }`)
Posts the reverse entry and returns the invoice to `UNAPPROVED`. Not possible after money was paid (later step). Returns `200` with the invoice.

### GET `/purchase-invoices/:id/accounts-entry`  (the "Accounts" button)
```json
{
  "invoiceId": "uuid", "invoiceLabel": "00012", "status": "APPROVED", "posted": true,
  "current": {
    "entryNo": 41, "entryDate": "2026-10-24", "status": "POSTED", "narration": "Purchase invoice 00012 - NEXUS CHEMICAL (bill S-SES2358)",
    "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "5001", "name": "Purchases" }, "debit": 5700, "credit": 0 },
               { "lineNo": 2, "account": { "code": "1104", "name": "Input Sales Tax" }, "debit": 990, "credit": 0 },
               { "lineNo": 3, "account": { "code": "2101", "name": "Accounts Payable" }, "debit": 0, "credit": 6690, "partyType": "VENDOR", "partyId": "uuid" } ],
    "totals": { "debit": 6690, "credit": 6690 }, "balanced": true
  },
  "entries": [ "...every entry of this invoice, oldest first..." ]
}
```
- Show `current` in the "Accounts entry" popup (title "Accounts entry", subtitle "Posted to the ledger"): the table Account / Debit / Credit, the Total row, and the green line "Debit equals credit." when `balanced` is true.
- `current` is `null` and `posted` is `false` while the invoice is Un-approved. Then show "Not posted yet. Approve the invoice to post it to the ledger."
- `entries` is the full history: after an un-approve you see the first entry (`status: REVERSED`) and the reverse entry (`reversalOfId` set). Optional: show it under "History".

## 6. Rules and errors

Errors look like `{ "error": { "code", "message", "details?" } }`. `400 VALIDATION_FAILED` is a bad value. The codes below are `422` unless written otherwise. Show `message` to the user.

| code | When |
|---|---|
| `INWARD_NOT_APPROVED` | A chosen store purchase is not approved in the store yet. |
| `INWARD_OTHER_VENDOR` | A chosen purchase belongs to another vendor; one invoice is for one vendor. |
| `INWARD_TAKEN` | The purchase is already on another purchase invoice (the message names it). |
| `NO_AMOUNT` | The purchase has no amount, so there is nothing to bill. |
| `INWARDS_REQUIRED` | The vendor was changed without choosing the purchases of the new vendor. |
| `BILL_NO_TAKEN` | This vendor's bill number is already entered (the message names the invoice). |
| `DUE_BEFORE_DATE` | The due date is before the invoice date. |
| `INVOICE_APPROVED` | An approved invoice cannot be edited or deleted. Un-approve it first. |
| `ALREADY_APPROVED` / `NOT_APPROVED` | Approve on an approved invoice / un-approve on one that is not approved. |
| `NOTHING_TO_BILL` | The invoice amount is zero. |
| `HAS_PAYMENTS` | Money was paid against the invoice; it cannot be un-approved. |
| `DEFAULT_ACCOUNT_INACTIVE` | One of the default accounts (Purchases, Input Sales Tax, Accounts Payable) was switched off in the Chart of Accounts. The message names it. Ask the user to switch it on. (It can appear on Save and on Approve.) |
| `ENTRY_ON_PURCHASE_INVOICE` | **In the Store screens** (Correct / Un-approve of a purchase): the purchase is on a purchase invoice. Un-approve or delete that invoice first. |
| `NOT_FOUND` (404) | The invoice, vendor or purchase does not exist in this company. |
| `FORBIDDEN` (403) | No `ACC_PURCHASES` service, or VIEW only. |

## 7. What to build

1. **Purchase Invoices screen** (list): the six summary cards, the filters (Show: All / Approved / Un-approved, dates, Search, Apply, Clear), the table (Voucher, Date, Vendor + vendor's bill no, Due date, Amount, Tax, Net, Paid, Balance), and the "New purchase invoice" and "Export" buttons. Clicking a row opens the invoice.
2. **Invoice form** (new and open): header with the status badge and the buttons from `canEdit`, `canApprove`, `canUnapprove`, `canDelete`. Fields: Vendor (picker), NTN / Address (read only from `vendor`), Vendor's bill # , Invoice date, Due date, Notes, Details. The lines table with **Select purchases** (the list above, with a Chemical / General filter). The totals bar shows GROSS, SALES TAX, NET, PAID, BALANCE. The **Payments** tab is empty for now (payments come in a later step).
3. **Buttons:** Save (new) / Update (edit); Approve; Un-approve (ask for an optional reason); Delete (confirm); Accounts (opens the popup); Print (the frontend makes the print layout); Close.
4. After every Save, Update, Approve or Un-approve, replace the whole screen with the invoice returned by the server.
5. Totals shown while the user is still choosing purchases may be worked out in the browser from the `amount` and `salesTax` of the ticked purchases, for display only. The server's numbers after Save are the real ones.
6. After Approve / Un-approve, a small link **"Check the books"** that opens the Trial Balance.
7. In the Store screens, show the `ENTRY_ON_PURCHASE_INVOICE` message when Correct / Un-approve of a purchase is refused.

## 8. Notes

- **Dates:** plain dates `YYYY-MM-DD`. The books use the invoice date.
- **One invoice, one vendor.** For two vendors make two invoices.
- **Nothing is deleted from the books.** Un-approve posts a reverse entry.
- Goods **returned to the vendor** and **payments to the vendor** come in later steps (a debit note and the Payment Voucher). Until then the invoice shows the full amount of the store purchases.
- A bill for services or expenses that did not come through the store (rent, a repair) is not part of this screen yet.
