# "Others" on the Sales Invoice and the Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Both invoice forms get two new fields: **Others** (an amount) and **Others note** (what it is for).

## 1. The idea in plain words

- **Purchase invoice:** the vendor's goods came damaged or short. The owner types the amount in **Others** and the **bill becomes smaller** by that amount (we pay the vendor less). The note says why ("Damaged bags").
- **Sales invoice:** an extra charge for the customer (packing, freight ...). The owner types the amount in **Others** and the **bill becomes bigger** by that amount. The note says why.
- Both fields are **optional** (0 and empty by default). It is a plain amount, **not a percentage**.
- **No tax is worked out on Others**: the sales tax stays on the goods amount (`gross`) only.

## 2. Fields (both invoices)

Send on `POST /sales-invoices` / `PATCH /sales-invoices/:id` and on `POST /purchase-invoices` / `PATCH /purchase-invoices/:id`:

| Field | Meaning |
|---|---|
| `othersAmount` | The others amount, **zero or more** (never negative: the invoice type decides the direction). A number with at most 2 decimals (`500.5`) or a decimal string (`"500.50"`). More than 2 decimals, a negative number, text or `null` = `400 VALIDATION_FAILED`. To remove it send `0`. |
| `othersNote` | Free text, up to 300 characters: what the amount is for. Optional (you may make it required in the screen when the amount is more than 0; the server does not force it). |

Example (purchase): `{ "othersAmount": 100, "othersNote": "Damaged bags" }`. On `PATCH` send only what changed; `othersNote` stays as it was when you do not send it. Changing it is possible only while the invoice is **un-approved** (after Approve: `422 INVOICE_APPROVED`; un-approve first).

## 3. What the invoice answers (list, `GET /:id`, create, update, approve)

New fields on **both** invoices:
```json
{ "othersAmount": 100, "othersNote": "Damaged bags", "othersEffect": "DEDUCT" }
```
- `othersEffect` is `"DEDUCT"` on a **purchase** invoice (it reduces the bill) and `"ADD"` on a **sales** invoice (it increases the bill). Use it for the label and the sign, e.g. **"Others (deducted)"** with `- 100.00` on purchases, **"Others (added)"** with `+ 100.00` on sales. Show the note next to it.
- Totals (every number is the server's, show them as received):

| Invoice | gross | tax | net (the bill) |
|---|---|---|---|
| Purchase | the purchases | on the purchases only | `gross + tax - othersAmount` |
| Sales | the gate passes | `gross x taxRate / 100` | `gross + tax + othersAmount` |

  Example purchase: gross 700, tax 0, others 100 -> **net 600**. Example sales: gross 11,200, tax 2,016, others 500 -> **net 13,716**.
- `net` is what the customer owes / what we owe the vendor, so `balance`, `paymentStatus`, the payments, the balances and the reports all use `net` (nothing else to change).
- In the totals block of the form add one row **Others** between **Tax** and **Net**. A live preview while typing is fine; the real numbers come from the server's answer to Save.

## 4. The "Accounts" popup (what is posted at Approve)

- **Sales invoice** with others 500 (gross 11,200, tax 2,016): Debit Accounts Receivable 13,716 (customer named); Credit Sales 11,200; **Credit Sales 500** (a separate line, narration "... others - <note>"); Credit Output Sales Tax 2,016.
- **Purchase invoice** with others 100 (gross 700): Debit Purchases 700; **Credit Purchases 100** (a separate line, narration "... others - <note>"); Credit Accounts Payable 600 (vendor named). With tax, the Input Sales Tax debit sits between them.
- Both lines of others are on the same default account (Sales / Purchases), so no new account is needed and the Chart of Accounts does not change. When others is 0 there is no extra line. Show the lines as they come in `accounts-entry` (nothing to compute).

## 5. Errors

| code | When |
|---|---|
| `OTHERS_MORE_THAN_BILL` (422) | **Purchase invoice only:** others is more than the bill (`gross + tax`). `details`: `{ others, bill }`. Show "Others cannot be more than the bill". |
| `VALIDATION_FAILED` (400) | `othersAmount` negative, with more than 2 decimals, not a number, or `null`. |
| `INVOICE_APPROVED` (422) | Changing others of an approved invoice. |

## 6. Build checklist

1. Both invoice forms: add **Others** (number box, default 0) and **Others note** (text) near the totals; send them on create and update; bind to `othersAmount` / `othersNote` when editing.
2. Totals block: a row **Others** with the sign from `othersEffect` (`DEDUCT` = minus, `ADD` = plus); **Net** from the server.
3. Purchase form: handle `OTHERS_MORE_THAN_BILL`.
4. Test: purchase invoice of 700, others 100 "Damaged bags" -> net 600; Approve -> the Accounts popup has Purchases 700 Dr, Purchases 100 Cr, Accounts Payable 600 Cr. Sales invoice of 13,216, others 500 -> net 13,716; Approve -> Accounts Receivable 13,716 Dr, Sales 11,200 Cr, Sales 500 Cr, Output Sales Tax 2,016 Cr. Un-approve, set others to 0, approve again: no extra line.
