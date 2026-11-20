# Weaving — Yarn Inward: "For weft / For warp / For both" — Frontend Guide

Continues `weaving-yarn-inward.md`. The **Weaving > Inwards > Yarn Inward** form now asks **what the yarn is for**: **For weft**, **For warp** or **For both**. Exactly one of the three is chosen (a radio group / segmented buttons) and it is saved on the entry and shown in the entry and the list. (This is the *weaving* yarn inward, `/api/v1/weaving/yarn-inwards`; the Store > Yarn Inward is a different screen and is not changed.)

## 1. The field
New optional field **`purpose`** on `POST /api/v1/weaving/yarn-inwards` and `PATCH /api/v1/weaving/yarn-inwards/:id`:
```json
{ "vendorId": "...", "itemId": "...", "bags": 10, "lbsPerBag": 100, "ratePerLb": 300, "purpose": "WEFT" }
```
| value | shown as |
|---|---|
| `WEFT` | For weft |
| `WARP` | For warp |
| `BOTH` | For both |
- Letter case does not matter (`warp` = `WARP`); any other value → 400.
- **Not sent on a new entry = `BOTH`** (also the default of the form: pre-select "For both"). Entries made before this change are `BOTH`.
- Works for both kinds of entry: a vendor purchase and a customer (overhead) entry.
- `GET /weaving/yarn-inwards/form-data` now also answers **`purposes`** `[ { value: "WEFT", text: "For weft" }, { value: "WARP", text: "For warp" }, { value: "BOTH", text: "For both" } ]` and `defaultPurpose: "BOTH"`: build the radio group from it.

## 2. In the answers
Every yarn inward (add / edit / one entry / list) has **`purpose`** (`WEFT | WARP | BOTH`) and **`purposeText`** (`For weft | For warp | For both`). Show a **"For"** column / tag in the Yarn Inward list and the entry view.

## 3. List filters — `GET /weaving/yarn-inwards`
- **`?purpose=WEFT|WARP|BOTH`** — exactly that kind (e.g. a "For weft" tab).
- **`?usableFor=WEFT|WARP`** — the yarn that can be used for weft (entries "for weft" **and** "for both"), or for warp ("for warp" **and** "for both"). Use it to offer only the right yarn in a picker (e.g. the weft outward screen). `usableFor=BOTH` → 400.
Both work together with the other filters (`search, type, vendorId, customerId, itemId, dateFrom, dateTo`).

## 4. Editing
`purpose` can be changed on an entry at any time — also when the entry is on a purchase invoice or yarn has already gone out of it (it does not touch the books or the stock). The other fields keep their existing locks.

## Database
Migration `20261225000001-weaving-yarn-inward-purpose.js` (`yarn_inwards.purpose`, default `BOTH`). Run `npm run db:migrate`.
