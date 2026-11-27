# RECEIVABLE AGEING AND CREDIT FOLLOW-UP (N-C2)

Whom to ask for money first: for each customer, what is unpaid and **how many days past the due date**, in five columns. Customers over their credit limit or more than 60 days past due are **on top**. For each customer the accountant can write **follow-up notes** (who spoke, what was promised, until when). Notes are text only: **nothing is sent** (no e-mail, no WhatsApp).

Only people with an accounting service (**Reports `ACC_REPORTS`, Sales Invoice `ACC_SALES` or Receipts `ACC_RECEIPTS`**) can open it. A production person (SO Card service only) gets **403** on every route below: do not show the page or the menu item to him.

## 1. How the numbers are made
- Every **approved** sales invoice that is not fully paid goes into a column by its **due date**: **not due yet**, **1-30**, **31-60**, **61-90**, **over 90** days past due.
  The due date is the one typed on the invoice, else invoice date + the customer's **credit days** (the same rule as the invoice itself). Due **today** is not past due.
- The ledger can say more than the invoices: an **advance** the customer paid, an opening balance, a journal entry. That is the column **"Advances / other"** (`other`); an advance is **negative**.
- So for every customer: **not due + 1-30 + 31-60 + 61-90 + over 90 + other = balance**, and `balance` is the **ledger balance** of the customer (the same figure as the party ledger and the credit limit warning).
- **Credit limit** is a warning (as everywhere): `availableCredit = limit - balance` (negative when over the limit).
- All the customers together are compared with the **receivable account of the trial balance** (`reconciliation`).
- The unpaid part of an invoice is as of **today**; `asOf` only changes the day the age is counted from.

## 2. The report: `GET /api/v1/reports/receivable-ageing`
Listed in the Reports menu (key `receivable-ageing`, accounting people only). Query (all optional): `asOf` (YYYY-MM-DD, default today), `customerId`, `search` (name or code), `tab=attention` (only the customers to chase: over the limit or past 60 days), `page`, `limit`, `export=true` (every row for PDF / Excel / print).

Row:
```json
{ "customerId": "…", "code": 1, "name": "A TEXTILES", "creditLimit": null, "creditDays": 15,
  "current": 4000, "d1_30": 0, "d31_60": 5000, "d61_90": 0, "d90plus": 8000, "other": 0, "balance": 17000,
  "openInvoices": 3, "oldestInvoiceDate": "2026-07-28", "oldestInvoiceNo": 12, "maxDaysPastDue": 105,
  "availableCredit": null, "overLimit": false, "attention": true, "attentionReasons": ["OVER_60_DAYS"], "attentionText": "Over 60 days",
  "followUps": 2, "lastFollowUp": { "date": "2026-11-25", "note": "Called the accountant, cheque promised", "promisedDate": "2026-11-30", "promisedAmount": 4000, "by": "Ali" } }
```
- Customers with nothing owed (no unpaid invoice and balance 0) are not listed.
- Order: **attention first** (`attention: true`), then the biggest balance. `attentionReasons`: `OVER_LIMIT`, `OVER_60_DAYS` (a customer can have both). Show these rows **red / with a tag**.
- `creditLimit` / `availableCredit` are `null` when the customer has no limit. A negative `availableCredit` means over the limit.
- `lastFollowUp` is the newest note (or `null`); `followUps` is how many notes the customer has.
- `totals` of the section: `current`, `d1_30`, `d31_60`, `d61_90`, `d90plus`, `other`, `balance`, `customers`, `attention`.
- **`reconciliation`** at the top of the answer (only when the whole company is shown, not with a customer / search / tab filter): `{ "customersTotal": 22000, "controlAccountBalance": 22000, "difference": 0 }`. `difference` should be 0; if not, show a small warning "the ageing does not agree with the trial balance" (some entry has no customer on it).
- `buckets`: the column keys in order. At most 5,000 customers (else **422 `REPORT_TOO_BIG`**).

## 3. One customer (the drawer): `GET /api/v1/reports/receivable-ageing/:customerId`
```json
{ "customer": { "id": "…", "code": 1, "name": "A TEXTILES", "creditLimit": null, "creditDays": 15 }, "asOf": "2026-11-26", "balance": 17000,
  "invoices": [ { "invoiceId": "…", "invoiceNo": 12, "invoiceDate": "2026-07-28", "dueDate": "2026-08-12", "net": 10000, "received": 2000, "unpaid": 8000, "daysPastDue": 105, "bucket": "d90plus" } ],
  "followUps": [ { "id": "…", "date": "2026-11-25", "note": "…", "promisedDate": "2026-11-30", "promisedAmount": 4000, "by": "Ali", "createdAt": "…" } ] }
```
Click a customer row to open this: the unpaid invoices (oldest first) with their age, and the notes. A link on each invoice opens the invoice; a link "Open ledger" opens the party ledger of the customer. 404 for a customer of another company.

## 4. Follow-up notes: `GET` / `POST /api/v1/customers/:id/follow-ups`
Accounting service: VIEW reads, FULL adds (the client admin always can).
`POST` body:
```json
{ "date": "2026-11-25", "note": "Called the accountant, cheque promised", "promisedDate": "2026-11-30", "promisedAmount": 4000 }
```
- `note` is required (2 to 1,000 characters). `date` is optional (default today). `promisedDate` and `promisedAmount` are optional (`null` allowed).
- **422 `PROMISE_BEFORE_NOTE`**: the promised day is before the day of the note (`details.field = "promisedDate"`).
- Answer (201) and `GET`: `{ "data": [ …all the notes of the customer, newest first… ] }`.
- Notes cannot be edited or deleted (it is a history). Each add is written in the audit log.

## 5. The screens (suggested)
**Reports > Receivable ageing**:
- A filter bar: "As of" date, customer, search, and a switch "Only customers to chase" (`tab=attention`).
- A table: customer, **the five columns**, advances / other, balance, credit limit, available credit, oldest invoice, days past due, tag (Over credit limit / Over 60 days), follow-ups. Totals row. Rows with `attention` red.
- Click a customer: the **drawer** (section 3) with the invoices and the notes, an "Add note" form (note, promised date, promised amount), and an "Open ledger" link.
- A **print view for the accountant** (the list with the five columns, `export=true`).
- A small note under the table when `reconciliation.difference` is not 0.

## 6. Quick checks
1. A customer with a 10,000 invoice due 105 days ago (2,000 already paid): 8,000 in "over 90".
2. An invoice due **today**: "not due yet". The next day: "1-30". 30 days past due: "1-30"; 31 days: "31-60"; 60 / 61 and 90 / 91 the same.
3. A customer paid 3,000 in advance with no invoice: "Advances / other" is -3,000 and the balance -3,000.
4. A customer over the credit limit is on top with the tag "Over credit limit" and a negative available credit.
5. Add a note with a promised date: it shows as the last follow-up in the list and in the drawer.
6. The total of the balances equals the receivable account of the trial balance (`reconciliation.difference` 0).
7. A production user does not see the page and gets 403; another company sees none of these customers.
