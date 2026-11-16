# Weaving — Sizing charges in the Accounts (sizing purchase invoice) — Frontend Guide

The sizing party (our **vendor**) charges us for the sizing: **lbs used × rate per lb**, written on every **Sizing Inward** receipt (`weaving-sizing-inward.md`). We owe it that money, so it is billed in the **Accounts > Purchase Invoice**, exactly like the yarn purchase invoice, with a third kind: **Sizing**. Paying the vendor is the normal **Payment Voucher**.

## 1. Purchase Invoice screen — the three kinds
Every purchase invoice has `kind`: **`STORE`** (store purchases), **`YARN`** (weaving yarn bought from a vendor, `weaving-accounts-invoices.md`) and now **`SIZING`**
 (sizing receipts), with `kindText` (`Store` / `Yarn` / `Sizing`). The Kind filter is `GET /purchase-invoices?kind=STORE|YARN|SIZING`. Add **Sizing** to the "New invoice" kind choice and to the Kind column / tag.

## 2. Making a sizing invoice
1. Choose the **vendor** — the sizing party (from `GET /vendors?module=ALL`; weaving vendors have `module: "WEAVING"`).
2. The lines are that vendor's **sizing receipts** that are not on an invoice yet: `GET /api/v1/purchase-invoices/sizing-inwards?vendorId=<id>&search=&invoiceId=<when editing>` →
   ```json
   { "data": [ { "inwardId": "...", "inwardNo": 1, "inwardLabel": "00001", "inwardDate": "2026-11-12", "dcNo": "SZ-77", "description": null,
                 "challanNo": 1, "challanText": "00001", "beams": 2, "meters": 10000, "lbsUsed": 2400, "cutConeKg": 50, "ratePerLb": 10,
                 "amount": 24000, "salesTax": 0, "net": 24000, "canBill": true, "blockedReason": null } ], "total": 1 }
   ```
   The user ticks one or more receipts (**one invoice, one vendor**). The amount is `lbsUsed × ratePerLb`; the **cut cone is not charged** (it is not in the amount).
3. **Tax rate** (`taxRate`; the tax is worked out on every line like the other purchase invoices), **bill no** (the sizing party's own bill number), invoice date, due date (empty = the vendor's credit days), notes, bill details, others (taken off the bill) — the same fields as the purchase invoice (`purchase-invoice.md`).
4. `POST /api/v1/purchase-invoices` `{ "vendorId": "...", "sizingInwardIds": ["<inwardId>", ...], "taxRate": 18, "billNo": "SZ-BILL-9", "invoiceDate": "..." }`. Send **`sizingInwardIds`** instead of `inwardIds` / `yarnInwardIds` (only one of the three: 400). `PATCH` the same way (a sizing invoice takes only `sizingInwardIds`: 422 `WRONG_INVOICE_KIND` for the others).
5. The answer is the usual purchase invoice JSON with `kind: "SIZING"` and **`lines`**:
   ```json
   "lines": [ { "lineNo": 1, "inwardId": "...", "inwardNo": 1, "inwardLabel": "00001", "inwardDate": "2026-11-12", "dcNo": "SZ-77", "challanNo": 1, "challanText": "00001",
                "beams": 2, "meters": 10000, "lbsUsed": 2400, "cutConeKg": 50, "ratePerLb": 10, "amount": 24000, "salesTax": 4320, "net": 28320 } ]
   ```
   Show the lines as: receipt no, date, challan, beams, meters, lbs used, rate, amount, tax.

## 3. Approve, the books and the default account
- **Approve / un-approve / delete / "Accounts" button / payments**: the same calls and rules as every purchase invoice (`POST /purchase-invoices/:id/approve`, `/unapprove`, `DELETE`, `GET .../accounts-entry`).
- **Approve posts**: **Debit Sizing Charges** (gross) / **Debit Input Sales Tax** (tax) / **Credit Accounts Payable** (net, **the sizing vendor named**). The narration says "Sizing purchase invoice ...". Un-approve posts the reversal (both stay in the books).
- **Default accounts**: **Sizing Charges** (expense, in *Cost of Sales*) is a **new default account**. If the company has none it is **made automatically the first time a sizing invoice is saved** and shows in the **Chart of Accounts**; Input Sales Tax and Accounts Payable are made as for every purchase invoice. It is listed in the **Default Accounts tab** (`GET /accounts/defaults`, key `SIZING_CHARGES`, group `PURCHASE_INVOICE`, title "Sizing Charges"; make it in advance with `POST /accounts/defaults/SIZING_CHARGES/create`, and the key is accepted by the change / create calls). If the user switched it off: 422 `DEFAULT_ACCOUNT_INACTIVE`.
- The vendor's **ledger / statement**, the **Accounts Payable balance**, the **Trial Balance** (rows Sizing Charges, Input Sales Tax, Accounts Payable) and the accounting overview include it like any purchase invoice; the Trial Balance checks cover it ("every approved purchase invoice agrees with the ledger").

## 4. The sizing receipt in weaving
Sizing Inward list / entry have two new fields: **`invoiced`** and **`purchaseInvoice: { id, voucherNo, voucherLabel, status } | null`**. A receipt that is on a purchase invoice **cannot be deleted or have its beams / lbs / rate / date changed** (only its DC no and description): 422 `ON_PURCHASE_INVOICE` (`details: { invoiceId, voucherNo }`). Show a badge "Billed (00001)" and disable the Edit / Delete buttons; delete the invoice first (the receipt is free again).

## 5. Errors
422 `INWARD_OTHER_VENDOR` (a receipt of another sizing party), `INWARD_TAKEN` (already on invoice N), `NO_AMOUNT` (the receipt has no amount), `WRONG_INVOICE_KIND`, `INVOICE_APPROVED`, `ALREADY_APPROVED`, `HAS_PAYMENTS` (money was paid: cannot un-approve), `DEFAULT_ACCOUNT_INACTIVE`, plus the usual invoice errors; 404 for a receipt that is not of this company.

## Database
Migration `20261213000001-weaving-sizing-invoice.js` (`purchase_invoices.kind` accepts `SIZING`, `purchase_invoice_sizing_inwards`, default account role `SIZING_CHARGES`). Run `npm run db:migrate`.
