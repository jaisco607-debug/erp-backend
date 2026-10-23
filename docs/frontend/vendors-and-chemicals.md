# Vendors and Chemicals screens (Chemical Store)

Two separate master screens. Both need the Chemical Store (or General Store, for vendors) service: VIEW = list/see, FULL = add/edit/delete.

## 1. Vendors screen  (`/api/v1/vendors`)

Form (same as the "Customers master file" picture): tabs Basic / Bank / Tax. Buttons: Save, Delete, New, Close.

- `GET /vendors/options` -> `{ statuses, types, payments, provinces }`. Fill the STATUS, TYPE, PAYMENT dropdowns from it (INDIVIDUAL/COMPANY/AOP, VENDORS, CHQ/CASH/ONLINE/PAY_ORDER). Defaults: INDIVIDUAL, VENDORS, CHQ.
- `GET /vendors?search=&isActive=&page=&limit=` list. `GET /vendors/:id` one.
- `POST /vendors` add. Only `name` is required. `code` (Customer ID) is made by the server (next number), do not send it.
- `PATCH /vendors/:id` edit (send only changed fields; `isActive:false` switches a vendor off).
- `DELETE /vendors/:id` -> 204. A vendor that already has an inward cannot be deleted: error `IN_USE`, show "Already used, switch it off instead" and offer the switch (`isActive:false`).

Fields: Basic tab `name, legalName, status, type, payment, cnic, ntn, gstNo, email, phone (CONTACT #), address, city, province`. Bank tab `bankName, bankBranch, accountTitle, accountNo, iban`. Tax tab `ntn, gstNo` (same fields as in Basic; show them where the picture shows them). Attachments button: not built in the backend yet (tell the owner if it is needed).
Email must be a valid address. Empty text = send `""` or leave it out.

Vendors added here appear automatically in the Chemical Inward screen vendor dropdown (`GET /stores/chemical/inwards/form-data` -> `vendors`, active only). Typing a new vendor name on the inward screen still works too.

## 2. Chemicals screen  (`/api/v1/stores/chemical/...`)

Only the chemical entry is made here, no stock.
- Categories: `GET/POST /stores/chemical/categories`, `PATCH/DELETE /stores/chemical/categories/:id`. Brands: same under `/brands`. Show "add category" / "add brand" next to the dropdowns so they can be created on the spot.
- Chemicals: `GET /stores/chemical/items?search=&categoryId=&brandId=&isActive=`, `POST /stores/chemical/items`, `PATCH /stores/chemical/items/:id`, `DELETE /stores/chemical/items/:id` (204).
- Create body: `{ name, unit, categoryId, brandId }`. `unit` is a two-option toggle: `KG` or `LTR` (the Chemical Store accepts nothing else; error `CHEMICAL_UNIT`). `categoryId` and `brandId` are optional but the screen should ask for them (inwards are shown category-wise).
- The unit cannot change once the chemical has stock or an inward (`UNIT_LOCKED`). A used chemical cannot be deleted (`IN_USE`): switch it off with `isActive:false`.

Chemical Inward screen: `GET /stores/chemical/inwards/form-data` gives `categories`, `brands`, `items` (each item has `category`, `brand`, `unit`, `label`) and `vendors`. Dropdown 1 = category, dropdown 2 = chemicals of that category (filter `items` by `category.id` on the client, or call `GET /stores/chemical/items?categoryId=...&isActive=true`).

## 3. PDF / Excel of the lists

Both lists accept `?export=true` (plus the same filters, no paging). The answer is the standard report shape: `{ title, generatedAt, filters, sections:[{ key, title, columns:[{key,label,type}], rows, totals }], total, export:true }`. Build the file exactly like the reports (see `reports.md`): PDF with jsPDF + autotable, Excel with SheetJS, from `sections[0].columns` and `rows`.
- Vendors: `GET /vendors?export=true` (title "Vendors list").
- Chemicals: `GET /stores/chemical/items?export=true` (title "Chemicals list": category, chemical, brand, unit, stock, average rate, stock value, state).
Put a "Download PDF" and "Download Excel" button above each list; the filters on screen (search, category, active) are sent along.
