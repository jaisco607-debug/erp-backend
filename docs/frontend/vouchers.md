# Vouchers: Payment Voucher, Receipt Voucher, Journal Voucher: frontend guide

Written for: the frontend developer (and the AI that helps them). Read section 1 first: it explains in plain words what each voucher does to the books. The three vouchers work the same way (draft, confirm, move to draft); the parts that differ are in their own sections.

## 1. The ideas in plain words

- A **voucher** is the paper (the screen) for one money event. There are three kinds:
  - **Payment Voucher (VPV)**: we **pay a vendor** (a supplier) from a bank or cash account.
  - **Receipt Voucher (CRV)**: a **customer pays us**, into a bank or cash account.
  - **Journal Voucher (JV)**: everything else, in accountant's form: any debit and credit lines that balance (a cash deposit into the bank, bank charges, the owner's capital, a loan, an adjustment).
- Every voucher goes through the same steps:
  1. **Save** makes a **Draft**. A draft can be changed or deleted and has **no effect** on the books or on the invoices.
  2. **Confirm** posts the **accounting entry** (the books change) and, for payments and receipts, marks the invoices as paid. After this the voucher is **locked**.
  3. **Move to draft** (un-confirm) undoes a confirmed voucher: the server posts a reverse entry (nothing is erased) and the invoices' paid amounts go back. Then the voucher can be changed and confirmed again.
- **Advance**: money paid or received **before** a bill or an invoice exists. The user ticks "Advance" instead of choosing a bill / invoice. It goes to its own account (Supplier Advances: money we gave a vendor in advance, an asset; Customer Advances: money a customer gave us in advance, which we owe him in goods, a liability), with the vendor / customer named, so it can be adjusted later.
- **Income tax withheld.** In Pakistan the payer often keeps back a part of the payment as income tax and pays it to the government:
  - when **we pay a vendor**, we withhold it (we owe it to the government): the vendor receives less;
  - when **a customer pays us**, he withholds it: we receive less, but the whole invoice is settled, and the withheld tax is an amount we can claim back later.

### What each voucher does to the books (the accounting entry)

**Payment Voucher** (example: bills 5,900 + 500, an advance of 600, income tax 0.25 % withheld):

| Account | Debit | Credit |
|---|---|---|
| Accounts Payable (each bill, the vendor is named) | 5,900 + 500 | |
| Supplier Advances (each advance, the vendor is named) | 600 | |
| Income Tax - Vendors (what we withheld) | | 17.50 |
| Bank or Cash (what we really paid) | | 6,982.50 |
| **Total** | **7,000** | **7,000** |

In words: we owe the vendor less (Payable goes down by the bills), we gave him an advance (an asset), we owe the government 17.50, and the bank paid out 6,982.50.

**Receipt Voucher** (example: a cheque of 9,800 with 2 % income tax withheld settles an invoice of 10,000, plus an advance of 1,000):

| Account | Debit | Credit |
|---|---|---|
| Bank or Cash (the cheques) | 10,800 | |
| Income Tax - Customers (what the customer withheld) | 200 | |
| Accounts Receivable (each invoice, the customer is named) | | 10,000 |
| Customer Advances (each advance, the customer is named) | | 1,000 |
| **Total** | **11,000** | **11,000** |

**Journal Voucher** (example: 5,000 cash deposited into the bank):

| Account | Debit | Credit |
|---|---|---|
| Bank Account | 5,000 | |
| Cash in Hand | | 5,000 |

A transfer between cash and bank is **not** income and not expense: it is only a move between two asset accounts.

## 2. Access

| Voucher | Service | Base path |
|---|---|---|
| Payment Voucher | **`ACC_PAYMENTS`** | `/api/v1/payment-vouchers` |
| Receipt Voucher | **`ACC_RECEIPTS`** | `/api/v1/receipt-vouchers` |
| Journal Voucher | **`ACC_JOURNAL`** | `/api/v1/journal-vouchers` |

- Menu tab **`ACCOUNTS`** (with Chart of Accounts, Sales Invoice, Purchase Invoice, reports). Each voucher has its **own** service: the super admin gives them to a company, the client admin gives them to employees as VIEW or FULL.
- VIEW: list, open, see the accounts entry. FULL: also create, edit, delete, confirm, move to draft.
- Without the service every call answers `403 FORBIDDEN` (the service of another voucher does not help). Another company's data is never visible (`404`).
- Show a menu item only when the login response `services` list contains its service code.
- **Numbers:** each voucher type has its **own** number series per company, starting at 1: `voucherNo`, shown with zeros as `voucherLabel` (`00001`). The server gives it; the user never types it.

## 3. Things all three vouchers share

Every voucher answer has:

| Field | Meaning |
|---|---|
| `id`, `voucherNo`, `voucherLabel`, `voucherDate` | Identity and the date of the voucher (the books use it). |
| `status`, `statusText` | `DRAFT` ("Draft") or `CONFIRMED` ("Confirmed"). |
| `confirmedAt`, `confirmedBy` | When and by whom (null for a draft). |
| `canEdit`, `canDelete`, `canConfirm`, `canUnconfirm` | Show or hide the buttons by these. Do not work them out yourself. |
| `lines` | In the single-voucher answer only (not in the list). |

Common endpoints (replace `{path}` by `payment-vouchers`, `receipt-vouchers` or `journal-vouchers`):

| Call | What |
|---|---|
| `GET {path}/options` | Dropdown values (modes, bank and cash accounts, tax rate suggestions ...). |
| `GET {path}` | The list with a `summary` (the cards of the summary screen). Query: `status` (`DRAFT` or `CONFIRMED`), `dateFrom`, `dateTo`, `search`, `page` (default 1), `limit` (default 50), and `vendorId` (payments) / `customerId` (receipts). Newest voucher number first. |
| `GET {path}/:id` | One voucher with its lines. |
| `POST {path}` | Save a draft. `201`. |
| `PATCH {path}/:id` | Change a draft: send only what changed (when you send `lines`, send **all** the lines again). `200`. |
| `DELETE {path}/:id` | Delete a draft. `204`. |
| `POST {path}/:id/confirm` | Confirm (no body). `200` with the voucher. |
| `POST {path}/:id/unconfirm` | Move to draft. Optional body `{ "reason": "wrong cheque" }`. `200` with the voucher. |
| `GET {path}/:id/accounts-entry` | The "Accounts" popup: `{ posted, current, entries }` (the same shape as the invoices: `current` is the live entry with `lines` (account, debit, credit, party) and `totals`, or `null` while a draft; `entries` is the history including reversals). |

Money is a plain JSON number with at most 2 decimals. When **sending** an amount you may use a number (`5900.5`) or a decimal string (`"5900.50"`); more than 2 decimals is an error. Show amounts as received; do not add or multiply them in the browser (see the one allowed exception in section 5).

After **every** Save, Update, Confirm and Move to draft, replace the whole screen with the voucher the server returns.

**Payment modes** (`paymentMode`): `CASH`, `CHEQUE`, `ONLINE` (bank transfer / IBFT), `PAY_ORDER`. `chequeDate` and `chequeNo` are optional text/date; show them when the mode is `CHEQUE`.

## 4. Payment Voucher

### The screen (from the real software)
Header: **Pay from (bank / cash account)** + payment mode; **Pay to (vendor)**; Notes; Date; Cheque date; Cheque #. Then **Add bill payment**: Type ("Advance" tick), Vendor bill (picker), Bill ID, Bill date, Amount to pay, **Add**. A table of the lines (Line, Bill, IP #, Bill #, Bill date, Notes, Amount). Totals: **Bills total**, **Withholding** (income tax), **Net payable**.

### Dropdown data
`GET /payment-vouchers/options`
```json
{ "modes": [ { "code": "CASH", "text": "Cash" }, { "code": "CHEQUE", "text": "Cheque" }, { "code": "ONLINE", "text": "Online / bank transfer" }, { "code": "PAY_ORDER", "text": "Pay order" } ],
  "statuses": [ { "code": "DRAFT", "text": "Draft" }, { "code": "CONFIRMED", "text": "Confirmed" } ],
  "payFromAccounts": [ { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" } ],
  "incomeTaxRates": [ 0, 0.25, 0.5, 1, 1.5, 2, 3, 4.5, 5, 7.5, 10, 15 ] }
```
`payFromAccounts` are the bank and cash accounts of the company (the picker for "Pay from"). `incomeTaxRates` are **suggestions** for the dropdown; any rate from 0 up to 99.99 is accepted.

### The bills picker
`GET /payment-vouchers/bills?vendorId=...` (optional `search`, `limit`): the vendor's **approved purchase invoices that still have something to pay**.
```json
{ "data": [ { "purchaseInvoiceId": "uuid", "voucherNo": 12, "voucherLabel": "00012", "billNo": "S-SES2358", "invoiceDate": "2026-10-10", "dueDate": "2026-11-09",
              "billDetails": null, "net": 5900, "paid": 0, "balance": 5900, "ageDays": 16 } ], "total": 1 }
```
`balance` is what is still unpaid. `ageDays` is how old the bill is in days; the old software warns when a bill is younger than 45 days (optional: show a yellow note, it is your decision).

### Create (Save) and change
`POST /payment-vouchers`
```json
{ "vendorId": "uuid", "payFromAccountId": "uuid", "paymentMode": "CHEQUE", "voucherDate": "2026-10-26", "chequeDate": "2026-10-26", "chequeNo": "000123",
  "notes": "October", "taxSection": "153(1)(a)", "incomeTaxRate": 0.25,
  "lines": [ { "purchaseInvoiceId": "uuid", "amount": "5900.00", "notes": "" },
             { "purchaseInvoiceId": "uuid", "amount": 500 },
             { "advance": true, "amount": 600, "notes": "for the next order" } ] }
```
- Required: `vendorId`, `payFromAccountId`, `paymentMode`, `lines` (at least one). Everything else is optional (`voucherDate` = today, `incomeTaxRate` = 0).
- **A line is either a bill** (`purchaseInvoiceId`) **or an advance** (`"advance": true`), never both. One line per bill (a second line for the same bill answers `DUPLICATE_BILL`). A bill line pays part or all of the bill: `amount` may not be more than the bill's `balance`.
- `incomeTaxRate` is one rate for the **whole voucher** (the "tax section"; `taxSection` is only a text to print). Withholding = bills total x rate / 100, half a paisa up.
- Answer (`201`):
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "voucherDate": "2026-10-26",
  "vendor": { "id": "uuid", "code": 7, "name": "NEXUS CHEMICAL", "ntn": "1234567-8", "bankName": null, "iban": null },
  "payFrom": { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" },
  "paymentMode": "CHEQUE", "paymentModeText": "Cheque", "chequeDate": "2026-10-26", "chequeNo": "000123", "notes": "October",
  "taxSection": "153(1)(a)", "incomeTaxRate": 0.25,
  "billsTotal": 7000, "incomeTax": 17.5, "net": 6982.5, "typeText": "Bill + Advance",
  "status": "DRAFT", "statusText": "Draft", "canEdit": true, "canDelete": true, "canConfirm": true, "canUnconfirm": false,
  "lines": [ { "lineNo": 1, "kind": "BILL", "kindText": "Bill", "purchaseInvoiceId": "uuid", "billVoucherNo": 12, "billVoucherLabel": "00012", "billNo": "S-SES2358", "billDate": "2026-10-10",
               "billNet": 5900, "billBalance": 5900, "amount": 5900, "notes": null },
             { "lineNo": 3, "kind": "ADVANCE", "kindText": "Advance", "purchaseInvoiceId": null, "amount": 600, "notes": "for the next order" } ] }
```
- The totals bar: **Bills total** = `billsTotal`, **Withholding** = `incomeTax`, **Net payable** = `net` (what the bank pays). While the user is still typing (before Save) you may show `billsTotal` as the sum of the amounts; take the withholding and the net from the server's answer.
- The vendor's NTN, bank name and IBAN are in `vendor` (for the print and for the bank transfer file the old software exports).

### List and summary cards
`GET /payment-vouchers` returns `{ data: [ voucher without lines ], page, limit, total, summary }`, `summary = { vouchers, billAmount, withholding, netPaid }`: the four cards VOUCHERS, BILL AMOUNT, WITHHOLDING, NET PAID. The table columns: Voucher, Type (`typeText`), Ref# (use the cheque no / notes), Chq#, Date, Vendor / Bank, Bill amount (`billsTotal`), Withholding (`incomeTax`), Net amount (`net`). Filters: Show (All / Draft / Confirmed), From / To, Search (vendor, bank, cheque no).

### What Confirm does
The server checks every line **again** against the bills as they are at that moment, then posts the entry of section 1 and adds each line's amount to its bill's `paid` (see the invoice changes in section 8). If a bill was paid by another voucher in the meantime, Confirm answers `MORE_THAN_BALANCE` and the voucher stays a draft: tell the user and let him lower the amount.

### Errors (`422` unless written)
| code | When |
|---|---|
| `MORE_THAN_BALANCE` | A line is more than the bill's balance. `details`: `{ purchaseInvoiceId, balance, amount }`. |
| `BILL_OTHER_VENDOR` | The bill belongs to another vendor. |
| `BILL_NOT_APPROVED` | The purchase invoice is not approved yet. |
| `DUPLICATE_BILL` | The same bill on two lines. |
| `NOT_BANK_OR_CASH` | The "pay from" account is not a bank or cash account. |
| `NOT_POSTING_ACCOUNT` / `ACCOUNT_INACTIVE` | A folder was chosen / the account is switched off. |
| `BAD_AMOUNT` | An amount of zero or less, or a bad number. |
| `LINES_REQUIRED` | The vendor was changed without sending the lines again. |
| `NO_LINES` / `NOTHING_TO_PAY` | Confirm of a voucher without lines or with zero amount. |
| `VOUCHER_CONFIRMED` | A confirmed voucher cannot be changed or deleted: move it to draft first. |
| `ALREADY_CONFIRMED` / `NOT_CONFIRMED` | Confirm on a confirmed voucher / move to draft on one that is not confirmed. |
| `DEFAULT_ACCOUNT_INACTIVE` | A default account the voucher needs (Accounts Payable, Supplier Advances, Income Tax - Vendors) was switched off. The message names it. |
| `VALIDATION_FAILED` (400) | A bad value: a line without a bill or `advance`, a rate of 100 or more, an amount with 3 decimals, an empty `lines` ... |
| `NOT_FOUND` (404) | The voucher, vendor, bill or account does not exist in this company. |
| `FORBIDDEN` (403) | No service, or VIEW only. |

## 5. Receipt Voucher

### The screen (from the real software)
Header: **Deposit into (bank / cash account)** + payment mode; **Received from (customer)**; Notes; Date; Cheque date; Cheque #. Then **Add receipt line**: Type ("Advance" tick), Invoice (picker), Invoice ID, Invoice date, **Cheque amount**, **Income tax** (a % dropdown), **Bill amount** (worked out), **Add**. The lines table (Line, Invoice, Invoice #, Invoice date, Bill amount, IT rate, IT amount, Cheque amount). Totals: **Grand total (invoices)**, **Less: income tax**, **Net received (cheque)**.

### How the amounts work (important)
The customer pays a cheque and keeps back income tax; both together settle the invoice:

`bill amount = cheque amount + income tax`, and `income tax = cheque amount x rate / (100 - rate)` (half a paisa up).

Example: a cheque of 9,800 with 2 % gives income tax 200 and a bill amount of 10,000: the invoice is settled by 10,000. The user types the **cheque amount** and picks the **rate** per line; the server works out the income tax and the bill amount. To show the "Bill amount" box while the user types, you may use the same formula (display only); the server's numbers in the answer are the real ones.

### Dropdown data and the invoices picker
`GET /receipt-vouchers/options`: `{ modes, statuses, depositAccounts: [ { id, code, name, controlType } ], incomeTaxRates }` (as for payments).

`GET /receipt-vouchers/invoices?customerId=...` (optional `search`, `limit`): the customer's **approved sales invoices that still have something to receive**.
```json
{ "data": [ { "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "voucherNo": 1623, "voucherLabel": "01623", "invoiceDate": "2026-09-30",
              "invoiceDetails": "SMELL BLACK", "net": 611806.4, "received": 0, "balance": 611806.4, "ageDays": 26 } ], "total": 1 }
```

### Create (Save) and change
`POST /receipt-vouchers`
```json
{ "customerId": "uuid", "depositAccountId": "uuid", "paymentMode": "CHEQUE", "voucherDate": "2026-10-26", "chequeDate": "2026-10-26", "chequeNo": "556", "notes": "",
  "lines": [ { "salesInvoiceId": "uuid", "chequeAmount": "9800.00", "incomeTaxRate": 2 },
             { "advance": true, "chequeAmount": 1000 } ] }
```
- Required: `customerId`, `depositAccountId`, `paymentMode`, `lines`. A line is **an invoice** (`salesInvoiceId`) **or an advance** (`"advance": true`). `incomeTaxRate` is per line (0 up to 99.99, default 0). One line per invoice (`DUPLICATE_INVOICE`).
- A line may settle part or all of the invoice: the **bill amount** (cheque + income tax) may not be more than the invoice's `balance`.
- Answer (`201`): the same shape as the payment voucher, with
```json
{ "customer": { "id": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2" },
  "depositInto": { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" },
  "grandTotal": 11000, "incomeTax": 200, "net": 10800, "typeText": "Invoice + Advance",
  "lines": [ { "lineNo": 1, "kind": "BILL", "kindText": "Invoice", "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "invoiceDate": "2026-09-30", "invoiceNet": 11800, "invoiceBalance": 11800,
               "chequeAmount": 9800, "incomeTaxRate": 2, "incomeTax": 200, "billAmount": 10000, "notes": null },
             { "lineNo": 2, "kind": "ADVANCE", "kindText": "Advance", "salesInvoiceId": null, "chequeAmount": 1000, "incomeTaxRate": 0, "incomeTax": 0, "billAmount": 1000 } ] }
```
- Totals bar: **Grand total (invoices)** = `grandTotal` (sum of the bill amounts), **Less: income tax** = `incomeTax`, **Net received (cheque)** = `net` (what goes into the bank).

### List and summary cards
`GET /receipt-vouchers`: `summary = { vouchers, invoiceAmount, withholding, netReceived }`: the cards VOUCHERS, INVOICE AMOUNT, WITHHOLDING, NET RECEIVED. Table: Voucher, Type, Ref#, Chq#, Date, Customer / Bank, Invoice amount (`grandTotal`), Withholding (`incomeTax`), Net amount (`net`).

### Errors
The same as for payments, with: `MORE_THAN_BALANCE` (the bill amount of the line is more than the invoice's balance; `details`: `{ salesInvoiceId, balance, amount }`), `INVOICE_OTHER_CUSTOMER`, `INVOICE_NOT_APPROVED`, `DUPLICATE_INVOICE`, `NOT_BANK_OR_CASH`, `BAD_RATE` (rate outside 0 to 99.99), `NOTHING_TO_RECEIVE`, `DEFAULT_ACCOUNT_INACTIVE` (Accounts Receivable, Customer Advances, Income Tax - Customers).

## 6. Journal Voucher (JV)

### The screen
Header: Date, Reference (text, for example a cheque or slip number), Narration (the reason). Then a table of lines: **Account** (picker of accounts, not folders), **Debit**, **Credit**, Narration, and a **Customer / Vendor** picker that appears only for the accounts that need one. Below: the running **Total debit**, **Total credit** and the **difference**; Save and Confirm are enabled when the difference is 0 and there are at least 2 lines.

### Create (Save)
`POST /journal-vouchers`
```json
{ "voucherDate": "2026-10-26", "reference": "DEP-1", "narration": "Cash deposited in the bank",
  "lines": [ { "accountId": "uuid", "debit": 5000, "narration": "deposit" },
             { "accountId": "uuid", "credit": "5000.00" } ] }
```
- At least **two lines**. **Each line has either a debit or a credit** (more than zero), never both and never none. **Total debit must equal total credit**, else `422 UNBALANCED` with `details: { debit, credit, difference, side }` (`side` is the side that is missing).
- Only accounts (not folders) that are switched on.
- **Customer / vendor rule:** a line on **Accounts Receivable** or **Customer Advances** must name a **customer** (`partyId` = the customer id); a line on **Accounts Payable** or **Supplier Advances** must name a **vendor**. A line on any other account must **not** have a `partyId`. This keeps the customers' and vendors' own totals equal to these accounts. The account object of the Chart of Accounts has `controlType`: `CUSTOMERS` and `CUSTOMER_ADVANCES` need a customer picker; `SUPPLIERS` and `SUPPLIER_ADVANCES` need a vendor picker (`GET /journal-vouchers/options` returns this list as `partyControlTypes`). The server fills `partyType` itself.
- Answer (`201`):
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "voucherDate": "2026-10-26", "reference": "DEP-1", "narration": "Cash deposited in the bank",
  "total": 5000, "lineCount": 2, "balanced": true, "totals": { "debit": 5000, "credit": 5000 },
  "status": "DRAFT", "statusText": "Draft", "canEdit": true, "canDelete": true, "canConfirm": true, "canUnconfirm": false,
  "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "1102", "name": "Bank Account", "accountType": "ASSET" }, "debit": 5000, "credit": 0, "narration": "deposit",
               "partyType": null, "partyId": null, "partyName": null } ] }
```

### List and summary
`GET /journal-vouchers`: `summary = { vouchers, totalAmount }`. The table: Voucher, Date, Reference, Narration, Total (`total`), Status. `search` looks in the reference, the narration and the account names of the lines.

### Errors
`UNBALANCED`, `LINE_ONE_SIDE`, `NOT_POSTING_ACCOUNT`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_INACTIVE` (also when Confirm finds an account switched off since the draft was saved), `CONTROL_NEEDS_PARTY` (a receivable / payable / advance line without a customer or vendor), `LINE_BAD_PARTY` (a customer or vendor on another account), `NOT_FOUND` (404: unknown customer or vendor), `VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED`, `BAD_AMOUNT`, `400 VALIDATION_FAILED` (fewer than 2 lines, an amount with 3 decimals ...).

**Warning for the screen:** a journal voucher on Accounts Receivable or Payable changes the customer's / vendor's total, but it does **not** mark any invoice as paid. Use the Receipt / Payment Voucher to settle invoices. Tell the user in a small note on the JV screen.

## 7. New system accounts

Vouchers use four accounts besides the bank and cash accounts. They are **system accounts** (locked, see the Chart of Accounts guide): **Income Tax - Customers** (asset), **Income Tax - Vendors** (liability), **Customer Advances** (liability) and **Supplier Advances** (asset). The Chart of Accounts templates contain them, and the server also **makes them when the first voucher that needs them is saved**. The frontend does nothing; after a first Save reload the Chart of Accounts if it is open. A bank or cash account is made by the user (preset "Bank account" / "Cash in hand").

## 8. Changes in the Sales Invoice and Purchase Invoice screens

Receipts and payments now work, so the invoices come alive:

- `received` / `balance` (sales) and `paid` / `balance` (purchase) are **real**: they grow when a voucher is confirmed and shrink when it is moved to draft.
- New field **`paymentStatus`** on every invoice (list and single): `UNPAID`, `PARTIAL` or `PAID`. Show it as a small badge next to the status.
- New array **`payments`** in the single-invoice answer (`GET /sales-invoices/:id`, `GET /purchase-invoices/:id`): the **confirmed** vouchers that paid this invoice. Fill the **Payments** tab with it (the tab counter = its length):
  - sales: `{ voucherId, voucherNo, voucherLabel, voucherDate, paymentMode, chequeNo, chequeAmount, incomeTax, billAmount }`;
  - purchase: `{ voucherId, voucherNo, voucherLabel, voucherDate, paymentMode, chequeNo, amount }`.
  Link each row to its voucher (`/receipt-vouchers/:voucherId` or `/payment-vouchers/:voucherId`).
- **Un-approve** of an invoice is refused once money was received / paid: `HAS_RECEIPTS` (sales) / `HAS_PAYMENTS` (purchase). Move the voucher to draft first.
- Add a button **"Receive payment"** (sales invoice) / **"Pay bill"** (purchase invoice) on an approved invoice with a balance: it opens a new voucher with the customer / vendor and this invoice already chosen.

## 9. Trial Balance changes

The Trial Balance (`trial-balance.md`) has four new checks, so it now has **8 checks** in this order: `TRIAL_BALANCE_BALANCED`, `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS`, `SALES_INVOICES_MATCH_LEDGER`, `PURCHASE_INVOICES_MATCH_LEDGER`, then:

| key | What it checks | When it is red |
|---|---|---|
| `PAYMENT_VOUCHERS_MATCH_LEDGER` | Every **confirmed** payment voucher has exactly one live entry whose debit is its bills total; a **draft** has none | `mismatches[]`: `{ voucherId, voucherNo, reason, message, voucherTotal, ledgerDebit }`, `reason`: `CONFIRMED_WITHOUT_ENTRY`, `CONFIRMED_WITH_MANY_ENTRIES`, `AMOUNT_DIFFERS`, `DRAFT_IN_LEDGER` |
| `RECEIPT_VOUCHERS_MATCH_LEDGER` | The same for receipt vouchers (their grand total) | same shape |
| `JOURNAL_VOUCHERS_MATCH_LEDGER` | The same for journal vouchers (their total) | same shape |
| `INVOICE_PAYMENTS_MATCH_VOUCHERS` | What every invoice says was received / paid equals what its **confirmed** vouchers settled | `mismatches[]`: `{ kind: "SALES" or "PURCHASE", invoiceId, invoiceNo, message, invoiceSays, vouchersSettled }` |

Also, the check `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS` now lists the **advance** accounts too (Customer Advances, Supplier Advances) next to Accounts Receivable and Accounts Payable. Link a voucher mismatch to `/payment-vouchers/:id`, `/receipt-vouchers/:id` or `/journal-vouchers/:id`; in the account ledger the lines of a voucher have `sourceType` `PAYMENT_VOUCHER`, `RECEIPT_VOUCHER` or `JOURNAL_VOUCHER` and `sourceId` = the voucher id.

## 10. Step by step: what to build, in order

1. Menu items Payment Voucher, Receipt Voucher, Journal Voucher (each by its own service).
2. **Payment Voucher** summary screen (cards, filters, table), then the voucher form (header, "Add bill payment" with the bills picker and the Advance tick, the lines table, totals, buttons Save / Confirm / Move to draft / Delete / Accounts / Print / Close), then the "Accounts entry" popup.
3. **Receipt Voucher**: the same screens, with the cheque amount, income tax rate and computed bill amount per line.
4. **Journal Voucher**: summary screen and the form with the balancing table (running totals and difference, party picker only where needed).
5. In the invoice screens: `paymentStatus` badge, the Payments tab from `payments`, and the "Receive payment" / "Pay bill" buttons.
6. In the Trial Balance screen: the four new checks.
7. Test with a company that has a bank account: save a draft (nothing changes in the Trial Balance), confirm it (the Trial Balance moves and still balances), move it to draft (the closing amounts go back), try to pay more than a bill's balance, enter an advance.

## 11. Notes

- **Nothing is deleted from the books.** Moving a voucher to draft posts a reverse entry; both stay in the account ledger.
- Two draft vouchers can both aim at the same bill; the second one fails when it is confirmed if the money is no longer there (`MORE_THAN_BALANCE`).
- **Not built yet:** applying an advance to an invoice later (do it with a Journal Voucher: debit the advance account / credit Accounts Receivable with the customer named, or the other way round for a vendor), a debit note for goods returned to a vendor, bank reconciliation, and attachments (the frontend may keep attachments itself).
