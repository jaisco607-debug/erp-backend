# Store Yarn Inward in the Accounts (Purchase Invoice, Voucher, books) — Frontend Guide

The yarn bought from a vendor (**Store > Yarn Inward**, `store-yarn-inward.md`) is billed in **Accounts > Purchase Invoice**, **exactly like the chemical purchase** (and like the fabric purchase, `store-fabric-rates-accounts.md`): a 
purchase invoice made from the vendor's approved yarn inwards, approve posts the entry, paying the vendor is the normal **Payment Voucher**. The new invoice kind is **`STORE_YARN`** (`kindText`: `Store Yarn`). The weaving yarn invoice (`kind: YARN`, `weaving-accounts-invoices.md`) is a different thing and is unchanged.

## 1. Purchase Invoice screen — five kinds
`kind`: `STORE` (chemical / general), `YARN` (weaving yarn), `SIZING`, `FABRIC`, and now **`STORE_YARN`**. Add **Store Yarn** to the "New invoice" kind choice and to the Kind filter (`GET /purchase-invoices?kind=STORE_YARN`).

## 2. Making a store yarn invoice
1. Choose the **vendor** (the vendor the yarn was bought from, `GET /vendors`).
2. The lines are that vendor's **approved** yarn inwards that are not on an invoice yet: `GET /api/v1/purchase-invoices/store-yarn-inwards?vendorId=<id>&search=&invoiceId=<when editing>`
```json
{ "data": [ { "inwardId": "...", "inwardNo": 1, "inwardLabel": "00001", "inwardDate": "2026-11-10", "dcNo": "Y-1", "yarnName": "22/s Cotton", "brand": "Crescent", "title": "22/s Cotton - Crescent",
              "bags": 10, "lbsPerBag": 50, "lbs": 500, "ratePerLb": 300, "amount": 150000, "salesTax": 0, "net": 150000, "canBill": true, "blockedReason": null } ], "total": 1 }
```
   Amount = total lbs × the rate per lb typed on the yarn inward. An entry **without a rate** has `canBill: false` and a `blockedReason` ("give its rate per lb in the store first") — show it greyed out. Only approved entries are listed.
3. Tick one or more entries (**one invoice, one vendor**), the **tax rate** (`taxRate`, worked out on every line), **bill no** (the vendor's own bill number), invoice date, due date (empty = the vendor's credit days), notes, bill details, others (taken off the bill) — the same fields as every purchase invoice (`purchase-invoice.md`).
4. `POST /api/v1/purchase-invoices` `{ "vendorId": "...", "storeYarnInwardIds": ["<inwardId>", ...], "taxRate": 18, "billNo": "Y-77", "invoiceDate": "..." }`. Send **`storeYarnInwardIds`** instead of `inwardIds` / `yarnInwardIds` / `sizingInwardIds` / `fabricInwardIds` (only one of the five: 400). `PATCH` the same way; a store yarn invoice takes only `storeYarnInwardIds` (422 `WRONG_INVOICE_KIND` for the others).
5. The answer is the usual purchase invoice JSON with `kind: "STORE_YARN"` and **`lines`**: `lineNo, inwardId, inwardNo, inwardLabel, inwardDate, dcNo, yarnName, brand, title, bags, lbsPerBag, lbs, ratePerLb, amount, salesTax, net`. Show: inward no, date, DC, yarn, bags, lbs per bag, total lbs, rate per lb, amount, tax.

## 3. Approve, the books, the voucher — same as chemical
- **Approve / un-approve / delete / "Accounts" button / payments**: the same calls and rules as every purchase invoice (`POST /purchase-invoices/:id/approve`, `/unapprove`, `DELETE`, `GET .../accounts-entry`, payment vouchers against the invoice).
- **Approve posts**: **Debit Purchases** (gross) / **Debit Input Sales Tax** (tax) / **Credit Accounts Payable** (net, **the vendor named**). Narration "Yarn purchase invoice 00001 - <vendor> (bill ...)". Un-approve posts the reversal (both stay in the books).
- **Default accounts**: no new account — **Purchases**, **Input Sales Tax** and **Accounts Payable** (made on the first invoice if the company has none; shown in the Chart of Accounts and Default Accounts tab). 422 `DEFAULT_ACCOUNT_INACTIVE` if the user switched one off.
- The vendor's **ledger / statement**, the **Accounts Payable balance** (`GET /purchase-invoices/credit/:vendorId`), the **Trial Balance**, the Balance Sheet / Profit & Loss and the accounting overview include it like any purchase invoice; the Trial Balance checks ("every approved purchase invoice agrees with the ledger") cover it.
- Paying the vendor: the normal **Payment Voucher** against the purchase invoice (it shows in the invoice's `payments`).

## 4. The yarn inward in the store once it is billed
`GET /store-yarn-inwards` (list) and `GET /store-yarn-inwards/:id` now have **`invoiced`** and **`purchaseInvoice: { id, voucherNo, voucherLabel, status } | null`**. An entry that is on a purchase invoice **cannot be un-approved** (422 `ON_PURCHASE_INVOICE`, `details: { invoiceId, voucherNo }`): show a "Billed (00001)" badge and disable the Un-approve button; delete the invoice first (the entry is free again). Approved entries could not be edited / deleted anyway. Yarn that has gone out to departments can still be billed (the bill is for what was bought).

## 5. Errors
422 `INWARD_NOT_APPROVED`, `INWARD_OTHER_VENDOR`, `INWARD_TAKEN` (already on invoice N), `NO_AMOUNT` (the entry has no rate), `WRONG_INVOICE_KIND`, `INVOICE_APPROVED`, `ALREADY_APPROVED`, `HAS_PAYMENTS` (money was paid: cannot un-approve), `DEFAULT_ACCOUNT_INACTIVE`, plus the usual invoice errors; 404 for an entry that is not of this company.

## Database
Migration `20261223000001-store-yarn-purchase-invoice.js` (`purchase_invoices.kind` accepts `STORE_YARN` and is now `varchar(12)`, table `purchase_invoice_store_yarn_inwards`). Run `npm run db:migrate`. Yarn inwards entered without a rate cannot be billed: give them the rate per lb first (while still a draft).
