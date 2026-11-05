# Credit limit, credit days, due dates and the Due Schedule: frontend guide

Written for: the frontend developer (and the AI that helps them). This adds credit terms to the customer and vendor forms, a due date and a credit-limit warning to both invoices, and one new report ("Due schedule").

## 1. The idea in plain words

- **Credit days** (customers AND vendors): how many days after the invoice date the money is due. A customer with 30 days: invoice of 1 Oct is due on 31 Oct. For a vendor it is how long the vendor gives us.
- **Credit limit** (customers; vendors too but **optional**): the most a party may owe. Empty = no limit.
  - Customer: how much the customer may owe **us**.
  - Vendor: how much **we** may owe the vendor. Most companies leave it empty.
- The credit limit only **WARNS**. It never blocks anything: the invoice is saved and approved, and the server adds a `creditWarning` that the screen shows in yellow.
- Credit terms live on the **party form** (set once). Not on the inward and not on the voucher.

## 2. Customer form and Vendor form

Two new fields on `POST/PATCH /customers` and `POST/PATCH /vendors` (and in every answer of those and in the lists):

| Field | Meaning |
|---|---|
| `creditLimit` | A number with at most 2 decimals, `0` or more, or `null` / empty = no limit. Answer: a number or `null`. |
| `creditDays` | A whole number, `0` to `3650`. `0` = due the same day. Always a number in the answer (default `0`). Not `null`, not a string. |

- Send `creditLimit: null` to clear a limit. `0` is a real limit of zero (every sale warns), so do not send `0` for "empty".
- Wrong values (negative, text, more than 2 decimals, `creditDays` with a fraction) = `400 VALIDATION_FAILED`.
- Show **Credit limit** (optional, hint "empty = no limit") and **Credit days** (default 0) on both forms. For vendors you may keep the limit field small or under "More".

## 3. Sales invoice and Purchase invoice

### 3.1 Due date
- Both invoices have `dueDate` (`YYYY-MM-DD`, always in the answer). Send it on `POST` / `PATCH` to type your own; the server checks `dueDate >= invoiceDate` (else `422 DUE_BEFORE_DATE`).
- **Not sent (or empty)** = the server works it out: `invoiceDate + the party's creditDays`. With `creditDays = 0` the due date is the invoice date.
- On `PATCH`:
  - `dueDate` sent with a date: that date is used.
  - `dueDate` sent as `""` / `null`: worked out again from the credit days.
  - `dueDate` not sent: it stays, **except** when `invoiceDate` or the customer / vendor changes: then it is worked out again.
  - So on an edit form send the `dueDate` the user sees (pre-filled from the invoice); if they change the invoice date, clear the due date field or let it refresh from the answer.
- On the form: when the customer / vendor or the invoice date changes, preview `dueDate = invoiceDate + creditDays` (take `creditDays` from the party or from section 3.3) and let the user override it.
- Lists and `GET /:id` also have **`isOverdue`** (boolean): the invoice is approved, still has a balance and its due date is before today. Use it for a red "Overdue" badge.

### 3.2 Credit-limit warning: `creditWarning`
Every invoice answer (create, update, `GET /:id`, approve) has `creditWarning`:
```json
null
```
or, when the party is over the limit:
```json
{ "code": "CREDIT_LIMIT_EXCEEDED", "message": "This customer is over the credit limit: 13216.00 against a limit of 10000.00",
  "creditLimit": "10000.00", "balance": "0.00", "thisInvoice": "13216.00", "afterInvoice": "13216.00", "exceededBy": "3216.00" }
```
- `balance` = what the party owes us (customer) / we owe the party (vendor) today, from the books (so opening balances, receipts, payments and advances count). `thisInvoice` = this invoice while it is **un-approved** (it is not in the books yet); `0.00` once it is approved (already inside `balance`). `exceededBy` = how much is over the limit.
- `null` = no limit set, or within it. Money values are strings with 2 decimals.
- **Show it** as a yellow banner on the invoice screen ("Credit limit exceeded by 3,216.00") and keep **Save** and **Approve** enabled. Optionally ask "Continue?" before Approve.
- Sales invoice: warning about the **customer**. Purchase invoice: about the **vendor** (only when he has a limit).
- The warning stays on an approved invoice while the party is over the limit, so use it as information in the invoice screen, not as an error.

### 3.3 Credit status for the form (before saving)
- `GET /sales-invoices/credit/:customerId` (service ACC_SALES, VIEW) and `GET /purchase-invoices/credit/:vendorId` (service ACC_PURCHASES, VIEW):
```json
{ "partyType": "CUSTOMER", "partyId": "...", "code": 12, "name": "AZ TEXTILES",
  "creditLimit": "100000.00", "creditDays": 10, "balance": "40000.00", "available": "60000.00", "exceeded": false, "exceededBy": null }
```
- `creditLimit` and `available` are `null` when there is no limit. `available` is negative when the party is already over. Call it when the user picks the customer / vendor and show "Limit 100,000 · Owes 40,000 · Available 60,000 · Credit days 10". `404` = party not found (or of another company).

## 4. New report: Due schedule

`GET /accounting/due-schedule` (service **ACC_REPORTS**, VIEW). It answers "how much money is due to come in and go out in the next 15 days, 30 days ..." and also what is already overdue.

Query (all optional): `date` (default today; the "as of" day), `buckets` (comma list of day limits, default `15,30,60`; 1 to 3650, up to 8 numbers, e.g. `7,14,30`), `search` (party name, NTN, CNIC, code, invoice no, bill no), `detail=true` (also return the document lines).

Only **unpaid balances of approved invoices / bills** are counted (a part-paid invoice counts its remaining balance). The bucket of a document = `dueDate - date` in days.

Answer:
```json
{
  "date": "2026-10-29", "bucketDays": [15, 30, 60],
  "receivable": {
    "total": "63000.00", "count": 6, "overdue": "17000.00", "notYetDue": "46000.00",
    "buckets": [
      { "key": "OVERDUE_OVER_60", "label": "Overdue over 60 days", "side": "OVERDUE", "count": 0, "balance": "0.00" },
      { "key": "OVERDUE_31_60",   "label": "Overdue 31-60 days",   "side": "OVERDUE", "count": 1, "balance": "16000.00" },
      { "key": "OVERDUE_16_30", ... }, { "key": "OVERDUE_1_15", ... },
      { "key": "DUE_TODAY", "label": "Due today", "side": "TODAY", "count": 1, "balance": "8000.00" },
      { "key": "DUE_1_15",  "label": "Due in 1-15 days",  "side": "UPCOMING", "count": 1, "balance": "2000.00", "upToDays": 15, "cumulative": "10000.00" },
      { "key": "DUE_16_30", "label": "Due in 16-30 days", "side": "UPCOMING", "count": 1, "balance": "4000.00", "upToDays": 30, "cumulative": "14000.00" },
      { "key": "DUE_31_60", ... }, { "key": "DUE_AFTER_60", "label": "Due after 60 days", ... }
    ],
    "parties": [ { "partyId": "...", "code": 2, "name": "BILAL", "count": 4, "total": "60000.00", "buckets": { "OVERDUE_31_60": "16000.00", "DUE_TODAY": "8000.00", "DUE_1_15": "0.00", "...": "..." } } ],
    "documents": [ ... only with detail=true ... ]
  },
  "payable": { "...": "the same shape for vendors" },
  "net": [ { "key": "DUE_1_15", "label": "Due in 1-15 days", "balance": "1250.00" } ],
  "netTotal": "62250.00"
}
```
- `receivable` = money to come in from customers, `payable` = money to go out to vendors, `net` = receivable minus payable in every bucket (same order and keys as `buckets`; negative = more to pay than to receive). `netTotal` is the sum.
- **Buckets are in screen order** (oldest overdue first, then today, then the coming ones). Render them as columns; use `side` for the colour (OVERDUE red, TODAY amber, UPCOMING normal). The bucket keys depend on `buckets` (e.g. `DUE_1_7`), so loop over the answer, do not hard-code keys.
- `cumulative` (UPCOMING buckets only) is the running total up to that bucket **including due today**: "next 15 days: 10,000.00", "next 30 days: 14,000.00".
- `parties[].buckets` is an object `{ bucketKey: amount }` (every key present, `"0.00"` when empty): one table row per party with a column per bucket.
- `documents` (only with `detail=true`, otherwise absent), most overdue first: `{ bucket, id, label, billNo, date, dueDate, daysToDue (negative = overdue), partyId, partyName, amount, balance }`. Use it for the click-through list of a bucket (filter by `bucket`) or party (filter by `partyId`); `label` is the invoice no (sales) / voucher no (purchase).
- Suggested screen: date picker + bucket days box, two tables (Receivable / Payable) with the bucket columns and a total row, a third "Net" row, click a number to open the list of that bucket.

`dueDate` was also added to the document lines of `GET /accounting/cutoff?detail=true` and `GET /accounting/balances/open-items` (so those lists can show a Due column).

## 5. Old invoices
- Invoices made before this change have no stored due date: the server shows `invoiceDate + the party's creditDays` (so with `creditDays = 0` they are due on their invoice date and show as overdue once the date passes). Set the credit days on the party and the old invoices follow.

## 6. Build checklist
1. Customer form and vendor form: **Credit limit** (optional) and **Credit days**; show them in the lists if you like.
2. Sales and purchase invoice forms: **Due date** field (pre-filled invoice date + credit days, editable); send it only if the user typed it, or send the shown value.
3. Invoice screens: yellow banner from `creditWarning` (never block Save / Approve); red "Overdue" badge from `isOverdue`; due date column in the invoice lists.
4. On picking a customer / vendor call the `credit/:id` endpoint and show limit, balance, available and credit days.
5. New screen: **Due schedule** (receivable / payable / net by bucket, party rows, click-through with `detail=true`).
6. Test: customer limit 10,000 and 30 days; a sales invoice of 13,216 on 24 Oct -> due date 23 Nov and a warning "exceeded by 3,216"; Save and Approve still work. Vendor with no limit -> never a warning. Due schedule on 29 Oct shows an invoice due 5 Nov under "Due in 1-15 days".
