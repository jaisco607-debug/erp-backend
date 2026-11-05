# Sales tax moves from the Store Inward to the Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Small change, two screens: remove the tax option from the **store inward** screens, add a tax-rate field to the **purchase invoice** screen.

## 1. What and why

- Until now the chemical store inward had a bill type (GST / Other) and a GST % (the tax was entered in the store). The store people must not enter tax.
- From now on the **sales tax is chosen on the Purchase Invoice** (in Accounting), when the invoice is made. The invoice has one **Tax rate (%)** and the server works out the tax.
- The server already **ignores** any `billType`, `gstPercent` or `salesTax` sent to the store inward (so an old frontend does not break), but the fields must be removed from the screens.

## 2. Store inward screens (Chemical Store, and General Store if it shows the same fields): REMOVE

On the inward form (create / edit) and the inward list:
1. **Remove** the "Bill type" (GST / Other) dropdown, the **GST %** dropdown, and the **Sales tax** box. Do not send `billType`, `gstPercent`, `salesTax` in `POST /stores/:store/inwards` and `PATCH /stores/:store/inwards/:id` any more (if sent, the server ignores them).
2. `GET /stores/:store/inwards/form-data` now answers `billTypes: ["OTHER"]`, `gstRates: []` and `taxOnInward: false`. Do not build the bill-type or GST dropdowns from them; you can use `taxOnInward === false` to hide the fields.
3. The totals of an inward are now only the **amount** (qty x rate). Fields `salesTax`, `gstPercent`, `billType` still come in the answers (every new inward has `salesTax: 0`, `gstPercent: null`, `billType: "OTHER"`), so `billed` / `balance` equal the amount. Do not show the tax columns for new entries. **Older inwards** (made before this change) can still have a GST amount: if `salesTax > 0` show it as before (read only); do not hide it.
4. The list tabs "GST" / "Other" (`?tab=gst`, `?tab=other`): the GST tab only has older entries now. You may hide the tabs, or keep them for old data.

## 3. Purchase invoice screen (Accounting): ADD the tax rate

1. New field **Tax rate (%)** on the form header (same idea as the sales invoice's tax rate). Dropdown (or typed number): values from `GET /purchase-invoices/options` -> `taxRates: [0, 5, 10, 15, 17, 18]`; default `defaultTaxRate: 0`. Any number from 0 to 100 (2 decimals) is accepted.
2. Send it as a **number** (not a string): `POST /purchase-invoices` and `PATCH /purchase-invoices/:id`:
```json
{ "vendorId": "uuid", "inwardIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24", "billNo": "S-123", "taxRate": 18 }
```
`taxRate` is optional (0 if left out). On `PATCH` it can be changed while the invoice is **un-approved**; after Approve the invoice is locked (`INVOICE_APPROVED`) until it is un-approved.
3. The invoice answers (`GET /purchase-invoices`, `GET /purchase-invoices/:id`, create / update / approve) now have **`taxRate`** next to `gross`, `tax`, `net`. Show `taxRate` in the header and bind the field to it when editing. `gross` = total of the purchase amounts, `tax` = the sales tax, `net` = gross + tax. Show them as received; do not work the tax out in the browser (you may show a live preview, the server's numbers are the real ones).
4. **How the tax is worked out** (for the preview and the explanation):
   - each purchase (store inward) on the invoice that has **no tax of its own** gets `amount x taxRate / 100` (rounded to 2 decimals **per purchase**); the invoice tax is the sum;
   - an **older** inward that still carries its own GST **keeps it** and is **not** taxed again by the invoice rate (no double tax);
   - so for new inwards: `tax = sum of round(amount x rate / 100)` over the lines; every line in `lines[]` shows its own `salesTax` (the tax share of that line) and `net`.
   Example: purchases 200 and 500, rate 18 % -> line taxes 36 and 90 -> tax 126, net 826.
5. **Picker of purchases** (`GET /purchase-invoices/inwards?vendorId=`): each purchase shows `amount`, `salesTax` and `net` of the **inward** only. For new inwards `salesTax` is 0 there; do not show it as the tax of the invoice. The tax appears on the invoice after the rate is chosen. When the user changes the Tax rate, update the totals from the server's answer to `PATCH` (or call it on Save).
6. **Approve** posts the invoice as before: Debit Purchases (gross), Debit Input Sales Tax (tax, only if tax > 0), Credit Accounts Payable (net). Nothing else changes in the accounts, the Trial Balance, ledgers or reports.

## 4. Errors

| code | When |
|---|---|
| `VALIDATION_FAILED` (400) | `taxRate` below 0, above 100, with more than 2 decimals, or sent as text (`"18"`). Send a number. |
| `INVOICE_APPROVED` (422) | Changing the tax rate of an approved invoice: un-approve it first. |

## 5. Build checklist

1. Store inward form: remove Bill type, GST %, Sales tax; stop sending them; hide the tax columns for new entries (still show a tax amount of an older inward when it is more than 0).
2. Purchase invoice form: add Tax rate (default 0), send it on create and update, show `taxRate`, `tax` and `net` from the answer.
3. Test: make a chemical inward without tax (amount 1,000); on a purchase invoice choose 17 % -> tax 170, net 1,170; Approve -> the Accounts popup shows Purchases 1,000, Input Sales Tax 170, Accounts Payable 1,170. Change the rate before approving and the totals follow.
