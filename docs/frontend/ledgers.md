# Party Ledger, Accounts Payables / Receivables and Bank Summary: frontend guide

Written for: the frontend developer (and the AI that helps them). These are **reports**: they only read the books (the journal), so the screens have no Save button, except the clearing date in the Bank Summary. Nothing here is typed in twice: every number is worked out by the server from the posted entries.

## 1. The ideas in plain words

- **Party** = a customer or a vendor. Every entry that touches Accounts Receivable / Payable (and the advance accounts) names its party, so the books know what each party owes or is owed.
- **Accounts Payables** = the list of **vendors** with how much we owe each. **Accounts Receivables** = the same for **customers**: how much each owes us. One row per party.
- **Party Ledger** = the story of **one** party: every bill, invoice, payment and receipt in date order, with a running balance. It is what opens when the user presses **View** on a row of Accounts Payables / Receivables.
- **Balance side.** Every balance comes as a number plus a side: `CREDIT` (for a vendor: we owe him; for a customer: he paid us more than he owes, an advance) or `DEBIT` (for a customer: he owes us; for a vendor: we paid him more than we owe). Show "1,415,523 Cr" / "Dr"; `null` side = zero, show "-".
- **Bank Summary** = the movements of one bank account, with the date the bank **cleared** each cheque (a cheque we wrote or received is "uncleared" until the bank really moves the money), and the figures that agree our books with the bank statement.

## 2. Access

| Screen | Service | Calls |
|---|---|---|
| Party Ledger, Accounts Payables, Accounts Receivables | **`ACC_REPORTS`** (VIEW) | `/api/v1/accounting/party-ledger`, `/payables`, `/receivables` |
| Bank Summary | **`ACC_BANK`** (new: VIEW reads, FULL sets / removes clearing dates) | `/api/v1/accounting/bank-accounts`, `/bank-summary`, `/bank-clearing` |

Menu group `ACCOUNTS` (sub menu "Ledgers": Accounts Ledger (exists), Bank Summary, Party Ledger, Accounts Payables, and add Accounts Receivables). Show an item only when the login `services` list has its code. Without the service every call answers `403 FORBIDDEN`. Another company's party or account is `404`. The super admin must give `ACC_BANK` to the company; the client admin gives it to users.

All amounts here are **strings with 2 decimals** (`"1415523.00"`), like the Trial Balance. Format them for display; never add them up in the browser.

## 3. Accounts Payables / Receivables

`GET /accounting/payables` (vendors) and `GET /accounting/receivables` (customers). Same answer shape.

Query (all optional): `date` (as at this day, default today), `search` (name, NTN, CNIC or code), `includeZero` (`true` also lists parties whose balance is zero; default `false`), `page` (default 1), `limit` (default 20; the "R: 20" box; max 500).

```json
{ "partyType": "VENDOR", "date": "2026-10-26", "page": 1, "limit": 20, "total": 143,
  "totals": { "debit": "9694220.00", "credit": "11109743.00", "balance": "1415523.00", "balanceSide": "CREDIT" },
  "data": [ { "id": "uuid", "code": 194, "name": "AA MARKETING", "ntn": "E464384-2", "cnic": null,
              "debit": "9694220.00", "credit": "11109743.00", "balance": "1415523.00", "balanceSide": "CREDIT" } ] }
```

- Table columns: **View** (button), **ID** (`code`), **NAME**, **NTN#**, **CNIC#**, **DR AMNT** (`debit`), **CR AMNT** (`credit`), **BALANCE** (`balance` + `balanceSide`). Sorted by name. Pagination links 1 2 3 ... from `total` and `limit`. `total` counts the parties after the filters.
- `debit` and `credit` are everything posted up to `date` (including the opening balances). The footer of the page can show `totals`.
- **View** opens the **Party Ledger** of that row (section 4): `partyType` = `VENDOR` for payables and `CUSTOMER` for receivables, `partyId` = the row's `id`. Pass the dates the user chose; by default the Party Ledger starts at the beginning of the fiscal year.
- **Print**: print what is on screen (or the whole list with a big `limit`).
- Vendors / customers with a balance on the "wrong" side (for example a vendor with a Debit balance) are listed too: the `balanceSide` tells it.

## 4. Party Ledger

`GET /accounting/party-ledger?partyType=VENDOR|CUSTOMER&partyId=...`

Query: `partyType` and `partyId` (required), `dateFrom`, `dateTo` (default: start of the fiscal year to today; or `fiscalYear` = the year it starts in), `search` (the "Find in this ledger" box: narration, cheque no, voucher no, source, account), `kind` (the tab, one of `SALES_INVOICE`, `PURCHASE_INVOICE`, `PAYMENT_VOUCHER`, `RECEIPT_VOUCHER`, `JOURNAL_VOUCHER`; empty = All).

```json
{ "party": { "type": "VENDOR", "id": "uuid", "code": 194, "name": "AA MARKETING", "ntn": "E464384-2", "cnic": null },
  "dateFrom": "2026-07-01", "dateTo": "2026-10-26",
  "opening": { "balance": "0.00", "balanceSide": null },
  "totals": { "debit": "9694220.00", "credit": "11109743.00" },
  "closing": { "balance": "1415523.00", "balanceSide": "CREDIT" },
  "kinds": [ { "code": "PAYMENT_VOUCHER", "text": "Vendor payment", "count": 8 }, { "code": "PURCHASE_INVOICE", "text": "Purchase invoice", "count": 11 } ],
  "total": 19, "shown": 19, "truncated": false,
  "lines": [ { "entryId": "uuid", "entryNo": 12, "date": "2026-07-23",
               "sourceType": "PURCHASE_INVOICE", "sourceText": "Purchase invoice", "sourceId": "uuid", "docNo": 5874, "docLabel": "05874",
               "isReversal": false, "reversed": false,
               "ref": "S-SES2358", "chequeNo": null, "chequeDate": null,
               "particulars": "Purchase invoice 5874", "account": { "code": "2101", "name": "Accounts Payable" },
               "debit": "0.00", "credit": "1415523.00", "balance": "1415523.00", "balanceSide": "CREDIT" } ] }
```

The screen:
- Header cards: **OPENING BALANCE** (`opening`; "-" when `balanceSide` is null), **TOTAL DEBIT**, **TOTAL CREDIT**, **CLOSING BALANCE** (`closing` with Cr / Dr).
- Party line under the title: name, `A/C` = `code`, NTN.
- Tabs: **All** (count = `total`) and one tab per item of `kinds` with its `count` (the old software showed "GRN purchase 11", "Vendor payment 8"). Pressing a tab calls again with `kind=...`; the counts do not change with the tab or the search. `shown` is how many lines are in the table ("19 OF 19 ENTRIES").
- The table: **DATE** (`date`), **VOUCHER** (a **View** button and `sourceText` with `docLabel` below it), **REF / CHQ #** (`ref`: the cheque number of a payment / receipt, or the vendor's bill number of a purchase invoice), **PARTICULARS**, **DEBIT**, **CREDIT**, **BALANCE** (`balance` + side). First row: "Opening balance" with the `opening` figure.
- The **running balance is always the true balance** of the whole period, also when a tab or the search hides some lines.
- **View button on a line** opens the document by `sourceType` and `sourceId`: `SALES_INVOICE` -> `/sales-invoices/:id`, `PURCHASE_INVOICE` -> `/purchase-invoices/:id`, `PAYMENT_VOUCHER` -> `/payment-vouchers/:id`, `RECEIPT_VOUCHER` -> `/receipt-vouchers/:id`, `JOURNAL_VOUCHER` -> `/journal-vouchers/:id`.
- A voucher that was moved to draft stays in the ledger with its reversal: the original has `reversed: true`, the reversal line `isReversal: true`. Show them in grey with a small "reversed" note; the balance already accounts for both.
- `account` says on which account the line sits (for example Accounts Payable or Supplier Advances / Customer Advances). The balance mixes them: it is the party's total position.
- `truncated: true` means the period has more than 5,000 lines and the end is cut off: ask the user to narrow the dates.
- **PDF statement** and **Excel / CSV**: build them in the browser from this answer (there is no server export yet).
- The party picker at the top (the "+" box with the name): use the existing vendor / customer lists. Changing the party or the dates and pressing **Show** calls the endpoint again.

Errors: `404 NOT_FOUND` (the party is not in this company, or `partyType` does not match), `400 VALIDATION_FAILED` (missing `partyType` / `partyId`), `422 BAD_RANGE` (`dateFrom` after `dateTo`).

## 5. Bank Summary

### Picker
`GET /accounting/bank-accounts` -> `{ "data": [ { "id": "uuid", "code": "1102", "name": "Meezan Current" } ] }`: the active bank accounts (the dropdown "MEEZAN-CURRENT"). Cash accounts are not in it.

### The summary
`GET /accounting/bank-summary?accountId=...`

Query: `accountId` (required), `dateFrom`, `dateTo` (default: fiscal year start to today; the old screen defaulted to yesterday and today: send them), `status` (`ALL` default, `CLEARED`, `UNCLEARED`), `search` (narration, cheque no, voucher no).

```json
{ "account": { "id": "uuid", "code": "1102", "name": "Meezan Current" }, "dateFrom": "2026-10-25", "dateTo": "2026-10-26",
  "opening": { "balance": "20000.00", "balanceSide": "DEBIT" },
  "totals": { "debit": "0.00", "credit": "6500.00" }, "closing": { "balance": "13500.00", "balanceSide": "DEBIT" },
  "total": 1, "shown": 1, "truncated": false,
  "lines": [ { "lineId": "uuid", "entryId": "uuid", "date": "2026-10-26", "sourceType": "PAYMENT_VOUCHER", "sourceText": "Vendor payment", "sourceId": "uuid", "docNo": 1, "docLabel": "00001",
               "isReversal": false, "reversed": false, "chequeNo": "000123", "chequeDate": "2026-10-26", "particulars": "Payment voucher 00001 - NEXUS CHEMICAL (cheque 000123)",
               "debit": "0.00", "credit": "6500.00", "balance": "13500.00", "balanceSide": "DEBIT",
               "clearedDate": null, "cleared": false, "canClear": true } ],
  "uncleared": { "count": 1, "totals": { "debit": "0.00", "credit": "6500.00" },
                 "lines": [ { "lineId": "uuid", "date": "2026-10-26", "sourceType": "PAYMENT_VOUCHER", "docLabel": "00001", "chequeNo": "000123", "chequeDate": "2026-10-26", "particulars": "...", "debit": "0.00", "credit": "6500.00" } ] },
  "reconciliation": { "booksBalance": "13500.00", "booksSide": "DEBIT", "unclearedDeposits": "20000.00", "unclearedPayments": "6500.00", "bankBalance": "0.00", "bankSide": null } }
```

The screen (two panels like the old software):
- **Left panel** = `lines`: **Voucher** (`docLabel`, View as in the Party Ledger), **Chq Date** (`chequeDate`, else `date`), **Clr Date** (`clearedDate`), **CHQ#** (`chequeNo`), **Debit (PKR)** = money in, **Credit (PKR)** = money out, **Balance (PKR)** (running, with side), and the buttons: **Update** (set or change the clearing date: a date input, then `PUT /accounting/bank-clearing`) and **Remove** (`DELETE /accounting/bank-clearing/:lineId`). Show the buttons only when `canClear` is true **and** the user has FULL on `ACC_BANK`; remove only when `cleared` is true.
- **Right panel** = `uncleared.lines`: the money the bank has **not cleared yet** (Voucher, Date, CHQ#, Debit, Credit), with the counts and `uncleared.totals`. Its dropdown can filter the left panel with `status`.
- **Agreeing with the bank statement** (`reconciliation`): `booksBalance` (what our books say at `dateTo`) minus `unclearedDeposits` (cheques we received that the bank has not credited) plus `unclearedPayments` (cheques we wrote that the bank has not paid) = `bankBalance`, what the bank statement should show. Show these four lines under the table.
- A line is **uncleared at `dateTo`** when it has no clearing date or its clearing date is after `dateTo`.
- Lines of a reversed voucher (and the reversal lines) have `canClear: false`, are grey, and are never in the uncleared list.

### Setting the clearing date
`PUT /accounting/bank-clearing` body `{ "journalLineId": "<lineId>", "clearedDate": "2026-10-28" }` -> `200 { "journalLineId", "clearedDate" }`. Sets or changes it. After a successful call re-read the summary (or update that row and the totals from the next `GET`).
`DELETE /accounting/bank-clearing/:lineId` -> `204`.
Needs FULL on `ACC_BANK`. This does **not** change the books: it only records the bank's date.

Errors: `NOT_BANK_ACCOUNT` (422: the account or the line is not a bank one), `CLEARED_BEFORE_ENTRY` (422: the cleared date is before the line's own date), `NOT_CLEARABLE` (422: a reversed entry or a reversal), `BAD_DATE` (422), `NOT_FOUND` (404: unknown line, or `DELETE` of a line that has no clearing date), `FORBIDDEN` (403).

## 6. Step by step

1. Menu: Ledgers -> Accounts Ledger, Bank Summary, Party Ledger, Accounts Payables, Accounts Receivables (each by its service).
2. Accounts Payables / Receivables screen (date, rows per page, search, Print, pagination) with **View** opening the Party Ledger of the row.
3. Party Ledger (party picker, dates, Show, cards, tabs, search, table, links to the documents, PDF / Excel from the data).
4. Bank Summary (account picker, dates, two panels, Update / Remove of the clearing date, reconciliation lines).
5. Test: after a confirmed Payment Voucher the vendor's row grows on the Debit side and the Party Ledger shows the payment with its cheque number; the bank line appears uncleared; set the clearing date and it moves out of the right panel.

## 7. Notes

- Nothing is saved on the party screens; they are always live.
- The Party Ledger's closing balance equals the party's row in Accounts Payables / Receivables of the same day.
- Not built yet: server PDF / Excel export, bank statement import and automatic matching, a combined "statement" for customers who are also vendors.

## Party Ledger: reversal pairing, reversal date and document details (2026-10-30)

`GET /accounting/party-ledger` lines have new fields. Nothing was removed or renamed.

### 1. Pairing a reversed line with its reversal
Every line has:
| Field | Meaning |
|---|---|
| `reversedByEntryId`, `reversedByEntryNo` | on a line that WAS reversed (`reversed: true`): the entry that reversed it. Otherwise `null`. |
| `reversesEntryId`, `reversesEntryNo` | on a reversal line (`isReversal: true`): the entry it undoes. Otherwise `null`. |

Pair them exactly: a line with `reversedByEntryId = X` goes with the lines whose `entryId = X`; a line with `reversesEntryId = Y` goes with the lines whose `entryId = Y`. To hide a cancelled document, hide every line that has `reversedByEntryId` or `reversesEntryId` set. The ids are given even when the other entry is outside the chosen dates (it is then simply not in `lines`). The running `balance` is always the real one; hiding lines does not change it, so a hidden pair nets to zero.

### 2. Reversal date
A reversal is now posted on the **same date as the entry it reverses** (un-approve of an invoice, moving a voucher back to draft). So the ledger reads: original, reversal, then the re-confirmed entry, all in order, and the running balance never jumps in between. Reversals made before this change keep their old date (the day they were made); the pairing fields work for them too.
Note for reports: cancelling a document now removes its effect from its own date onward (the Trial Balance, Balance Sheet and cut-off reports of an earlier date change too, because that document no longer counts).

### 3. Details of the document on every line
New fields on each line (no extra call needed). They are `null` when they do not apply to the kind of line:
| Field | Sales / purchase invoice lines | Voucher lines |
|---|---|---|
| `gross` | the invoice gross (string, 2 decimals) | `null` |
| `tax` | the tax amount | `null` |
| `taxRate` | the tax % (number) | `null` |
| `othersAmount`, `othersNote` | others amount and its note | `null` |
| `details` | the invoice details text (`billDetails` of a purchase invoice, `invoiceDetails` of a sales invoice) | `null` |
| `notes` | the invoice notes | payment / receipt voucher notes |
| `voucherNarration` | `null` | journal / contra voucher narration |
| `entryNarration` | the narration of the accounting entry (all lines) | same |

`particulars` (the line's own narration, or the entry's) stays as it was. Amounts are strings like the other money fields.
