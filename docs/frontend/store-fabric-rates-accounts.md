# Store Management — Fabric Inward rates, and the Fabric purchase invoice / voucher in the Accounts — Frontend Guide

Continues `store-fabric-inward.md`. The cloth bought from a vendor now has a **rate** (per meter or per yard) typed on the Fabric Inward form, and the vendor's bill is made in **Accounts > Purchase Invoice** (a new kind **Fabric**), exactly like the chemical / yarn / sizing purchase invoices. Paying the vendor is the normal **Payment Voucher**.

## 1. Fabric Inward form — the rate
Add one field group to the form (section "Quantity" or a new "Rate" block): **Rate** (number) and **per Meter / per Yard** (default = the entry's unit). Fields on `POST /api/v1/fabric-inwards` and `PATCH /api/v1/fabric-inwards/:id`:
```json
{ "rate": 10, "rateUnit": "METER" }
```
- `rate`: positive number (up to 4 decimals), **optional**. `rateUnit`: `METER` or `YARD`; if left out it is the entry's unit. On `PATCH`, `rate: null` clears the rate. `GET /fabric-inwards/form-data` has `rateUnits: ["METER","YARD"]`.
- **Every thaan gets its own amount = its length × the rate**, and the entry gets the total. Per **meter**: the thaan's meters × rate; per **yard**: the thaan's yards × rate (yards are the thaan's length ÷ 0.9144). An entry without a thaan list (plain total): total meters / yards × rate.
- Answers (create / edit / list / one entry) now have: `rate`, `rateUnit`, `rateText` ("per meter" / "per yard"), `hasRate`, `amount` (total, null until a rate is given), and on every thaan `thaans[].amount`; the list / entry also has `invoiced` and `purchaseInvoice: { id, voucherNo, voucherLabel, status } | null`.
- Live preview on the form (the footer already shows THAANS / METERS / YARDS): show **AMOUNT** too — per thaan (length × rate) and the total. The server works out the same numbers on save (round to 2 decimals per thaan, total = sum of the thaan amounts).
- Changing the rate, the unit of the rate or the lengths on a draft re-works every thaan amount. An approved entry cannot be edited (as before).
- A rate is **not required** to save or approve an entry (stock works without it), but an entry **without a rate cannot be billed** (see section 3). Show a "No rate" badge when `hasRate` is false.
- **Stock** (`GET /fabric-inwards/stock`): every row has `amount` and `balanceValue` (value of the cloth still in the store = amount × balance ÷ inward meters; null without a rate), and `totals.balanceValue`.

## 2. Purchase Invoice screen — the fourth kind: Fabric
Every purchase invoice has `kind`: `STORE`, `YARN`, `SIZING` and now **`FABRIC`** (`kindText`: `Fabric`). Add **Fabric** to the "New invoice" kind choice and the Kind filter (`GET /purchase-invoices?kind=FABRIC`).

## 3. Making a fabric invoice
1. Choose the **vendor** (the vendor the cloth was bought from; normal vendors, `GET /vendors`).
2. The lines are that vendor's **approved** fabric inwards that are not on an invoice yet: `GET /api/v1/purchase-invoices/fabric-inwards?vendorId=<id>&search=&invoiceId=<when editing>`
```json
{ "data": [ { "inwardId": "...", "inwardNo": 1, "inwardLabel": "00001", "typeNo": "0001", "inwardDate": "2026-11-10", "dcNo": "DC-9", "quality": "PC TWILL", "pieces": 3,
              "meters": 150.5, "yards": null, "unit": "METER", "rate": 10, "rateUnit": "METER", "rateText": "per meter", "amount": 1505, "salesTax": 0, "net": 1505, "canBill": true, "blockedReason": null } ], "total": 1 }
```
   An entry without a rate has `canBill: false` and `blockedReason` ("give its rate in the store first") — show it greyed out. Only approved entries are listed.
3. The user ticks one or more entries (**one invoice, one vendor**), the **tax rate** (`taxRate`; worked out on every line like the other purchase invoices), **bill no** (the vendor's bill number), invoice date, due date (empty = the vendor's credit days), notes, bill details, others (taken off the bill) — the same fields as every purchase invoice (`purchase-invoice.md`).
4. `POST /api/v1/purchase-invoices` `{ "vendorId": "...", "fabricInwardIds": ["<inwardId>", ...], "taxRate": 18, "billNo": "FAB-77", "invoiceDate": "..." }`. Send **`fabricInwardIds`** instead of `inwardIds` / `yarnInwardIds` / `sizingInwardIds` (only one of the four: 400). `PATCH` the same way; a fabric invoice takes only `fabricInwardIds` (422 `WRONG_INVOICE_KIND` for the others).
5. The answer is the usual purchase invoice JSON with `kind: "FABRIC"` and **`lines`** (`lineNo, inwardId, inwardNo, inwardLabel, typeNo, inwardDate, dcNo, quality, pieces, meters, yards, unit, rate, rateUnit, rateText, amount, salesTax, net`). Show: inward no, date, DC, quality, pieces, meters/yards, rate, amount, tax.

## 4. Approve, the books, the voucher
- **Approve / un-approve / delete / "Accounts" button / payments**: the same calls and rules as every purchase invoice (`POST /purchase-invoices/:id/approve`, `/unapprove`, `DELETE`, `GET .../accounts-entry`, payment vouchers against the invoice).
- **Approve posts** (like the chemical purchase): **Debit Purchases** (gross) / **Debit Input Sales Tax** (tax) / **Credit Accounts Payable** (net, **the vendor named**). Narration "Fabric purchase invoice 00001 - <vendor> (bill ...)". Un-approve posts the reversal (both stay in the books).
- **Default accounts**: no new account — it uses the existing **Purchases**, **Input Sales Tax** and **Accounts Payable** (made on the first invoice if the company has none, shown in the Chart of Accounts / Default Accounts tab). 422 `DEFAULT_ACCOUNT_INACTIVE` if the user switched one off.
- The vendor's **ledger / statement**, **Accounts Payable balance** (`GET /purchase-invoices/credit/:vendorId`), **Trial Balance**, the accounting overview and the other reports include it like any purchase invoice; the Trial Balance checks ("every approved purchase invoice agrees with the ledger") cover it.
- Paying the vendor: the normal **Payment Voucher** against the purchase invoice.

## 5. The fabric inward in the store once it is billed
A fabric inward that is on a purchase invoice (`invoiced: true`) **cannot be un-approved** (422 `ON_PURCHASE_INVOICE`, `details: { invoiceId, voucherNo }`): show a "Billed (00001)" badge and disable the Un-approve button; delete the invoice first (the entry is free again). Approved entries could not be edited / deleted anyway.

## 6. Errors
422 `INWARD_NOT_APPROVED`, `INWARD_OTHER_VENDOR`, `INWARD_TAKEN` (already on invoice N), `NO_AMOUNT` (the entry has no rate), `WRONG_INVOICE_KIND`, `INVOICE_APPROVED`, `ALREADY_APPROVED`, `HAS_PAYMENTS` (money was paid: cannot un-approve), `DEFAULT_ACCOUNT_INACTIVE`, plus the usual invoice errors; 404 for an entry that is not of this company.

## Database
Migration `20261219000001-fabric-inward-rates.js` (`fabric_inwards.rateUnit / rate / amount`, `fabric_inward_thaans.amount`, `purchase_invoices.kind` accepts `FABRIC`, table `purchase_invoice_fabric_inwards`). Run `npm run db:migrate`. Fabric inwards entered before this migration have no rate: give them one (draft) or they cannot be billed.
