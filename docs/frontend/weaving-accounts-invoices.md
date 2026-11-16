# Weaving in the Accounts — yarn sales invoice, yarn purchase invoice, customers and vendors — Frontend Guide

The accounts of the weaving yarn are done in the **Accounts** module, with the **same screens** as the cloth sales invoice and the store purchase invoice. Nothing new is needed in the weaving menu for it (only the "Generate invoice" shortcut, `weaving-yarn-sale.md`).

## 1. Customers and vendors in the Accounts
Weaving has its own customers and vendors (`weaving-yarn-inward.md`). The Accounts must show them **together with** the old (processing) ones, in every party dropdown (Sales Invoice, Purchase Invoice, Receipt / Payment / Contra / Journal vouchers, ledgers):

- `GET /api/v1/customers?module=ALL` and `GET /api/v1/vendors?module=ALL` → both lists in one answer. (`module=WEAVING` = weaving only, `module=MAIN` or nothing = the old list only; the Grey Store / Store screens keep calling them without `module`.)
- Every customer / vendor now has **`module`** (`"MAIN"` or `"WEAVING"`) and **`moduleText`** (`"Processing"` / `"Weaving"`): show it as a small tag or a second line in the dropdown, because a weaving party and a processing party may have the same name and code.
- `GET /customers/:id?module=ALL` (and `/vendors/:id?module=ALL`) opens a party of either list. Only reading takes `module`; adding / editing weaving parties is done in the weaving screens.
- Access: the same services as before (customers: Grey Store; vendors: a store service). If a user has only accounting services, give the frontend the same access as before for the party lists.

## 2. Sales Invoice (Accounts) — yarn invoices
The Sales Invoice screen now shows **both kinds**: every invoice has `kind`: **`CLOTH`** (made of gate passes, as before) or **`YARN`** (made of weaving yarn sales), and `kindText` (`Cloth` / `Yarn`). Add a **Kind** filter (`GET /sales-invoices?kind=YARN|CLOTH`) and a Kind column / tag. Everything else of the list is unchanged.

### Making a yarn invoice
In "New invoice" let the user choose **Cloth** or **Yarn**. For **Yarn**:
1. Choose the **customer** (from `GET /customers?module=ALL`).
2. The lines are the customer's **yarn sales** (delivery challans) not yet invoiced: `GET /api/v1/sales-invoices/yarn-sales?customerId=<id>&search=&invoiceId=<when editing>` →
   ```json
   { "data": [ { "saleId": "...", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05", "description": "...", "brands": "Crescent",
                 "bags": 6, "lbs": 500, "amount": 176050, "canBill": true, "blockedReason": null } ], "total": 1 }
   ```
   The user ticks one or more sales (**one invoice, one customer**). Amount = what the sale cost the customer (lbs × rate of the challan).
3. Tax rate (`taxRate`, default 18), invoice date, due date, notes, invoice details, HS code (empty by default for yarn), others — the same fields as the cloth invoice (`sales-invoice.md`, `invoice-others.md`).
4. `POST /api/v1/sales-invoices` `{ "customerId": "...", "yarnSaleIds": ["<saleId>", ...], "taxRate": 18, "invoiceDate": "...", ... }`. Send **`yarnSaleIds` instead of `gatePassIds`** (never both: 400). `PATCH` the same way (`yarnSaleIds` replaces the sales; a yarn invoice only takes `yarnSaleIds`, a cloth invoice only `gatePassIds`: 422 `WRONG_INVOICE_KIND`).
5. The answer is the usual invoice JSON plus `kind: "YARN"`, `qty` = total **lbs** (`qtyUnit: "lbs"`) and **`lines`** = the sales:
   ```json
   "lines": [ { "lineNo": 1, "saleId": "...", "challanNo": 1, "challanText": "00001", "outwardDate": "2026-11-05", "description": "...", "bags": 6, "lbs": 500, "amount": 176050,
                "items": [ { "inwardCode": 1, "party": { "name": "Yarn Mills" }, "yarnCount": {...}, "brand": {...}, "packing": 24, "lbsPerBag": 100, "bags": 4, "lbs": 400, "ratePerLb": 350, "amount": 140000 } ] } ]
   ```
   Show the yarn invoice lines as: challan no, date, bags, lbs, amount, and (expandable) the items. For `kind = CLOTH` the lines are gate-pass lines as before (check `kind` to choose the layout).
6. Approve / un-approve / delete / "Accounts" button / payments: **exactly the same calls and rules as the cloth invoice**: `POST /sales-invoices/:id/approve`, `/unapprove`, `DELETE`, `GET /sales-invoices/:id/accounts-entry`. Approve posts **Debit Accounts Receivable (customer named) / Credit Sales / Credit Sales Tax (Output)**; the narration says "Yarn sales invoice ...".
7. **Default accounts**: Accounts Receivable, Sales and Sales Tax (Output) are made automatically (and show in the Chart of Accounts) the first time an invoice of either kind is saved, if the company does not have them. 422 `DEFAULT_ACCOUNT_INACTIVE` if the user switched one off.
8. Errors: 422 `SALE_OTHER_CUSTOMER` (a sale of another customer), `SALE_TAKEN` (already on invoice N: `message` has the number), `NO_RATES` (the sale has no amount), `YARN_SALES_REQUIRED` (customer changed without choosing the new customer's sales), plus all the usual invoice errors.
9. The sale in the weaving screen is held by its invoice (it cannot be changed or deleted there; delete the invoice and it is free again).
10. A yarn invoice is an ordinary sales invoice for the rest of the accounts: **Receipt Voucher** (open invoices of the customer once approved), Contra, party ledger / statement, aging, trial balance, accounting overview all include it.

## 3. Purchase Invoice (Accounts) — yarn bought from a vendor
The Purchase Invoice screen shows **both kinds**: `kind` **`STORE`** (store inwards, as before) or **`YARN`** (weaving yarn inward entries), `kindText` (`Store` / `Yarn`). Add a Kind filter (`GET /purchase-invoices?kind=YARN|STORE`) and a column / tag.

### Making a yarn purchase invoice (the "voucher" of the vendor's yarn)
In "New purchase invoice" let the user choose **Store** or **Yarn**. For **Yarn**:
1. Choose the **vendor** (from `GET /vendors?module=ALL`).
2. The lines are the yarn bought from that vendor (weaving **Yarn Inward** entries of type PURCHASE) not yet invoiced: `GET /api/v1/purchase-invoices/yarn-inwards?vendorId=<id>&search=&invoiceId=<when editing>` →
   ```json
   { "data": [ { "inwardId": "...", "inwardCode": 1, "inwardLabel": "00001", "inwardDate": "2026-11-01", "dcNo": "DC-1", "remarks": null,
                 "item": "22|s Cotton - Crescent - 24 - 100", "bags": 10, "lbsPerBag": 100, "lbs": 1000, "ratePerLb": 300, "amount": 300000, "salesTax": 0, "net": 300000,
                 "canBill": true, "blockedReason": null } ], "total": 1 }
   ```
   The user ticks entries (**one invoice, one vendor**).
3. Tax rate (`taxRate`; the tax is worked out on every line, like the store invoice), bill no (the vendor's own bill number), invoice date, due date, notes, bill details, others (taken off the bill) — the same fields as the store invoice (`purchase-invoice.md`).
4. `POST /api/v1/purchase-invoices` `{ "vendorId": "...", "yarnInwardIds": ["<inwardId>", ...], "taxRate": 18, "billNo": "B-77", ... }`. Send **`yarnInwardIds` instead of `inwardIds`** (never both: 400). `PATCH` the same way (422 `WRONG_INVOICE_KIND` for the wrong one).
5. The answer is the usual purchase invoice JSON plus `kind: "YARN"` and **`lines`** = the yarn entries (`lineNo, inwardId, inwardCode, inwardDate, dcNo, item, bags, lbsPerBag, lbs, ratePerLb, amount, salesTax, net`). For `kind = STORE` the lines are the store inwards as before.
6. Approve / un-approve / delete / Accounts button / payments: **same calls and rules as the store purchase invoice**. Approve posts **Debit Purchases (gross) / Debit Input Sales Tax / Credit Accounts Payable (net, vendor named)**; the narration says "Yarn purchase invoice ...". The default accounts (Purchases, Input Sales Tax, Accounts Payable) are made automatically on the first invoice if missing. Payments go through the **Payment Voucher** as always.
7. Errors: 422 `INWARD_OTHER_VENDOR`, `INWARD_TAKEN` (already on invoice N), `NO_AMOUNT`, 404 for an entry that is not a purchase of this company (a customer's own yarn cannot be put on a purchase invoice), plus the usual ones.
8. In the weaving **Yarn Inward** list / entry two new fields: `invoiced` and `purchaseInvoice: { id, voucherNo, voucherLabel, status } | null`. An entry that is on a purchase invoice can only change its DC no and remarks and cannot be deleted: 422 `ON_PURCHASE_INVOICE` (delete the invoice first). Show a badge "Invoiced (00001)" and disable the buttons.

## Database
Migrations `20261207000001-weaving-yarn-sale.js` and `20261208000001-weaving-yarn-invoices.js` (`sales_invoices.kind`, `sales_invoice_yarn_sales`, `purchase_invoices.kind`, `purchase_invoice_yarn_inwards`; `customers.module` / `vendors.module` are from `20261204000001`). Run `npm run db:migrate`.
