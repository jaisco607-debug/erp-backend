# PURCHASE RETURN INVOICE (debit note) + gate pass and delivery challan on a vendor return

## 1. What this is
A chemical (or general store) purchase of 120 kg x 500 = 60,000 was invoiced. 60 kg go back to the vendor. Before this change the stock went down but the purchase invoice stayed 60,000.

Now:
1. **The store return (VR-...)** gets a **gate pass number (OP-...)** and a **delivery challan number (RDC-...)** of ours, plus vehicle and driver. They are numbered by the backend when the return is saved.
2. **A Purchase Return Invoice** is made from one or more store returns. It is linked to the **original purchase invoice** and to the **store returns** (so also to their gate pass and challan).
3. When the return invoice is **approved**, the entry is the purchase entry the other way round, and the amount is taken off the original bill:

| Account | Debit | Credit |
|---|---|---|
| Accounts Payable (vendor named) | net (gross + tax) | |
| Purchases | | gross |
| Input Sales Tax | | tax |

The trial balance, the chart of accounts ledger and the vendor ledger follow by themselves. Un-approve posts the reverse entry (nothing is erased).

4. The **original purchase invoice** balance goes down: 60,000 becomes 30,000. The payment voucher and contra voucher lists already show the smaller balance, nothing to change there.

Menu: the same service as Purchase Invoice (`ACC_PURCHASES`: VIEW reads, FULL writes). No new service, no new permission.

## 2. Flow of the user
1. Store > Vendor Returns > **New return** (already there). New: fields **Vehicle no.** and **Driver name**. After saving, show the **Gate Pass** and **Delivery Challan** numbers; the screen can print both from the same response (section 3).
2. Accounts > Purchase Return Invoice > **New**: pick the vendor, the list of that vendor's returns appears, tick the returns, save. It is a draft.
3. **Approve**. The original bill balance falls.

A purchase return invoice needs the **original purchase invoice to be approved first**. If it is not, the return shows `canBill: false` with `blockedReason`.

## 3. Store vendor return: what changed (`/stores/:store/vendor-returns`)
`POST /stores/chemical/vendor-returns` (store FULL): two new optional fields.
```json
{ "returnDate": "2026-10-25", "vendorId": "uuid", "reason": "DAMAGED", "notes": "...",
  "vehicleNo": "LEA-123", "driverName": "Aslam",
  "lines": [ { "inwardLineId": "uuid", "qty": 60 } ] }
```
`GET /stores/chemical/vendor-returns/:id` and the POST answer have new fields:
```json
{ "gatePassNo": 1, "gatePassText": "OP-00001", "challanNo": 1, "challanText": "RDC-00001", "vehicleNo": "LEA-123", "driverName": "Aslam",
  "purchaseReturn": null,
  "lines": [ { "item": "Caustic Soda", "unit": "KG", "qty": 60, "rate": 500, "value": 30000, "ipNo": 1, "dcNo": "DC-1", "purchaseInvoiceId": "uuid", "purchaseInvoiceLabel": "00001" } ] }
```
- `purchaseReturn` is `null` until the return is on a return invoice; then `{ id, voucherNo, voucherLabel, status }`: make it a link.
- Each line shows the purchase invoice it belongs to (`purchaseInvoiceLabel`).
- The list (`GET .../vendor-returns`) rows also have `gatePassText`, `challanText`, `purchaseReturnLabel`.
- Returns made **before** this change have no gate pass / challan numbers (`null`): show a dash.
- The gate pass and the challan are printed by the frontend from this response (vendor, date, vehicle, driver, items with qty, reason). The signature lines are drawn by the frontend.
- **Cancel** of a return that is on a return invoice answers **422 `RETURN_INVOICED`** (`details.purchaseReturnId`): tell the user to delete / un-approve the return invoice first.

## 4. Purchase return invoice API (`/api/v1/purchase-returns`)

### 4.1 Choose the returns: `GET /purchase-returns/vendor-returns?vendorId=...[&invoiceId=][&search=][&limit=]`
`invoiceId` = the return invoice being edited, so its own returns stay in the list. Cancelled returns and returns already on another return invoice are not listed.
```json
{ "data": [ {
  "vendorReturnId": "uuid", "returnNo": 1, "returnText": "VR-00001", "returnDate": "2026-10-25", "store": "CHEMICAL", "storeText": "Chemical Store",
  "gatePassText": "OP-00001", "challanText": "RDC-00001", "reasonText": "Damaged / bad", "items": "Caustic Soda",
  "purchaseInvoice": { "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "billNo": null, "status": "APPROVED" },
  "gross": 30000, "tax": 0, "net": 30000, "canBill": true, "blockedReason": null, "blockedCode": null } ], "total": 1 }
```
`blockedCode`: `NOT_ON_INVOICE` (the purchase is not on a purchase invoice yet), `INVOICE_NOT_APPROVED`, `MANY_INVOICES` (the return has lines of purchases on different invoices: ask the user to make one return per purchase). Show the row greyed with the reason.

Amount: the value of the stock at its **purchase rate**; sales tax in the same proportion as the original bill charged it (a return of half the purchase gets half of its tax).

### 4.2 Create: `POST /purchase-returns` (FULL)
```json
{ "vendorId": "uuid", "vendorReturnIds": ["uuid"], "returnDate": "2026-10-25", "notes": "leaking drums" }
```
`returnDate` and `notes` optional (date defaults to today, and cannot be before the purchase invoice date). **All returns must be of purchases on the same purchase invoice** (one return invoice = one original invoice). Answer 201 with the detail (4.4).

Errors (422 unless noted): `INVOICE_NOT_APPROVED`, `NOT_ON_INVOICE`, `MANY_INVOICES`, `ALREADY_INVOICED`, `OTHER_VENDOR`, `RETURN_CANCELLED`, `RETURN_BEFORE_INVOICE` (`details.invoiceDate`), 404 `Vendor return`.

### 4.3 List: `GET /purchase-returns?page&limit&status&vendorId&purchaseInvoiceId&dateFrom&dateTo&search`
Rows like the detail without `lines`. `summary: { invoices, amount, tax, net }`. `search` finds the vendor name, bill no., notes, or the return / purchase invoice number.

### 4.4 Detail: `GET /purchase-returns/:id`
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "returnDate": "2026-10-25", "notes": "leaking drums",
  "vendor": { "id": "uuid", "name": "NEXUS CHEMICAL", "ntn": null, "address": null, "city": null },
  "purchaseInvoice": { "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "billNo": null, "invoiceDate": "2026-10-20", "net": 60000, "paid": 0, "returnedAmount": 30000, "balance": 30000 },
  "gross": 30000, "tax": 0, "net": 30000, "appliedAmount": 30000, "unappliedAmount": 0,
  "status": "APPROVED", "statusText": "Approved", "canEdit": false, "canDelete": false, "canApprove": false, "canUnapprove": true,
  "lines": [ { "lineNo": 1, "returnText": "VR-00001", "returnDate": "2026-10-25", "gatePassText": "OP-00001", "challanText": "RDC-00001", "vehicleNo": "LEA-123", "driverName": "Aslam",
    "store": "CHEMICAL", "item": "Caustic Soda", "unit": "KG", "qty": 60, "rate": 500, "ipNo": 1, "dcNo": "DC-1", "amount": 30000, "salesTax": 0, "net": 30000 } ],
  "vendorReturns": [ { "id": "uuid", "returnText": "VR-00001", "gatePassText": "OP-00001", "challanText": "RDC-00001", "vehicleNo": "LEA-123", "driverName": "Aslam", "store": "CHEMICAL" } ] }
```
- `appliedAmount` = the part taken off the original bill; `unappliedAmount` (only when approved) = the part that could not be taken off because the bill was already paid. See section 6.
- Make `purchaseInvoice` a link to the purchase invoice, and each `vendorReturns[]` row a link to the store return (gate pass / challan print).

### 4.5 Other calls
- `PATCH /purchase-returns/:id` (FULL, draft only): `{ vendorReturnIds?, returnDate?, notes? }`. The vendor cannot be changed.
- `DELETE /purchase-returns/:id` (FULL, draft only) -> 204.
- `POST /purchase-returns/:id/approve` (FULL) -> posts the entry and takes the amount off the bill. 422 `ALREADY_APPROVED`, `INVOICE_NOT_APPROVED`, `NOTHING_TO_RETURN`.
- `POST /purchase-returns/:id/unapprove` (FULL) `{ reason? }` -> reverse entry, the bill balance goes back. 422 `NOT_APPROVED`.
- `GET /purchase-returns/:id/accounts-entry` -> the entries (the "Accounts" button), same shape as the purchase invoice: `{ returnId, returnLabel, status, posted, current, entries }`.
- Approved invoice: edit and delete answer 422 `RETURN_APPROVED`.

## 5. Purchase invoice: what changed (`/purchase-invoices`)
The detail and the list rows have a new field and one changed meaning:
```json
{ "net": 60000, "paid": 0, "returnedAmount": 30000, "balance": 30000, "paymentStatus": "PARTIAL",
  "returns": [ { "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "returnDate": "2026-10-25", "net": 30000, "applied": 30000, "status": "APPROVED", "statusText": "Approved" } ] }
```
- **`paid`** is now only the money really paid with payment / contra vouchers.
- **`returnedAmount`** is what the approved return invoices took off the bill.
- **`balance` = net - paid - returnedAmount**: show this as "Balance to pay". The payment voucher bills list (`GET /payment-vouchers/bills`) and the contra bills list already use it.
- `returns` (detail only): the return invoices of this bill, to link to. Add a "Returns" tab or a line "Returned 30,000 (Return 00001)".
- The list `summary` also has `returnedAmount`; `summary.balance` already counts it.
- `paymentStatus`: `PARTIAL` while something (payment or return) settled only part of the bill; `PAID` when the bill is fully settled (by payment, return or both).
- **Un-approve** of a purchase invoice that has a return invoice (any status) answers 422 **`HAS_RETURNS`**: "delete or un-approve the return invoice first". `canUnapprove` is `false` while an approved return is on it.

## 6. The bill was already paid (or partly paid)
The return invoice always posts the full entry (the vendor owes us the goods' value). But only what is **still unpaid on the bill** can be taken off the bill. Example: bill 60,000, 50,000 already paid, return invoice 30,000:
- `appliedAmount` 10,000 (the bill becomes fully settled: `balance` 0, `returnedAmount` 10,000)
- `unappliedAmount` 20,000: shown on the return invoice in a yellow note, e.g. "20,000 could not be taken off the bill (already paid). The vendor owes us this amount: it shows as a debit balance in the vendor ledger." The vendor refunds it, or it is set off against his next bill.
Un-approve brings everything back exactly.

## 7. Vendor ledger and reports
- The party ledger (`GET /accounting/party-ledger`) lines of a return invoice have `sourceType: "PURCHASE_RETURN"`, `sourceText: "Purchase return"`, `docNo` / `docLabel` = the return invoice number, with gross / tax / notes like the purchase invoice lines. The `kind` filter also accepts `PURCHASE_RETURN`. Make `docNo` a link to `/purchase-returns/:id` for this type.
- The trial balance, ledgers and the chart of accounts ledger need no change.
- The store reports (vendor ledger of the store, purchases with `returnedAmount`) were already there and are unchanged.

## 8. Quick test list for the frontend
1. Buy 120 kg x 500, approve the store entry, make and approve the purchase invoice (60,000).
2. Return 60 kg: gate pass `OP-00001` and challan `RDC-00001` shown. The return shows no return invoice yet.
3. Purchase Return Invoice > New > the return is listed with 30,000 > save > approve.
4. The purchase invoice: balance 30,000, returned 30,000. The payment voucher offers 30,000 for this bill.
5. Trial balance: Accounts Payable 30,000 credit, Purchases 30,000 debit net.
6. Un-approve the return invoice: balance 60,000 again.
