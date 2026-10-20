# PACKING: packing list detail + GATE PASS form (3 copies)

## 1. What changed in the backend and database (migration 20261019000004)
- **New table `gate_passes`:** one gate pass per packing list.
  - Columns: `gatePassNo` (per company, 1, 2, 3 ...), `passDate`, `operatorName`, `driverName`, `vehicleNo`, `destination`, `remarks`, who created and updated it.
- The lots and thaan numbers are NOT stored. They are read from the packing list every time, so they are always correct.
- The client name is the customer of the SO card, the one chosen at grey inward.
- No signature in the backend. The frontend draws the signature lines.
- Create and edit are audited.

## 2. Screen: click a packing list
The list detail (`GET /departments/PACKING/packing-lists/:id`, already there) and a **Gate Pass** tab or button next to it.

## 3. Gate pass form
`GET /departments/PACKING/packing-lists/:id/gate-pass`
```json
{ "saved": false, "id": null, "gatePassNo": null, "passDate": "2026-10-19",
  "packingList": { "id": "uuid", "listNo": 1, "status": "FINAL", "statusText": "Final" },
  "soCard": { "id": "uuid", "cardNo": 5 }, "customer": { "id": "uuid", "code": 130, "name": "AZ" }, "quality": "PC TWILL", "colour": "BLACK",
  "lots": [ { "lotNo": 15, "thaanNos": [1, 2, 3], "thaanCount": 3 }, { "lotNo": 16, "thaanNos": [4, 7], "thaanCount": 2 } ],
  "totalThaans": 5,
  "operatorName": "Bilal", "driverName": null, "vehicleNo": null, "destination": null, "remarks": null,
  "copies": ["Packing", "Company guard", "Driver"] }
```
- When nothing is saved yet (`saved: false`), the form comes pre-filled: today's date and the packing list's maker as operator. All of it is editable.
- **Fields on the form:**
  - Gate pass No (shown after the first save)
  - Date (date picker)
  - Client name (`customer.name`, read only)
  - SO#, Quality, Colour (read only)
  - Lots: one line per lot, "Lot 15: 1, 2, 3" (numbers only, no meters)
  - Total thaans
  - Packing operator name (text, pre-filled)
  - Driver name (text)
  - Vehicle number (text)
  - Going to (destination, text)
  - Remarks (optional)
- A lot with several grades shows each thaan number once.

## 4. Save
`PUT /departments/PACKING/packing-lists/:id/gate-pass`
```json
{ "passDate": "2026-10-19", "operatorName": "Bilal", "driverName": "Akram", "vehicleNo": "LEA-1234", "destination": "Lahore", "remarks": "" }
```
- The first save creates it and gives the `gatePassNo`. Later saves edit the same pass. Fields you do not send stay as they were.
- The response is the same shape as the GET with `saved: true`.
- Errors: `NO_LINES` (the packing list has no thaans).
- Needs FULL access to Packing. VIEW access can only read.

## 5. Print: 3 copies
- `copies` = ["Packing", "Company guard", "Driver"].
- **UI:** a **Print** button prints the same pass 3 times (or 3 on one page, cut apart), each with its name at the top: "Packing copy", "Guard copy", "Driver copy".
- Every copy shows: Gate pass No, Date, Client, SO#, Lots with thaan numbers, Total thaans, Operator, Driver, Vehicle, Going to, and a signature line (drawn by the frontend).
- Save first, then print, so the Gate pass No is on the paper. If `saved` is false, show "Save first".

## 6. Gate pass list
`GET /departments/PACKING/gate-passes?search=&dateFrom=&dateTo=&page=1&limit=20`
- `search` looks in vehicle no, driver, destination and in numbers (Gate pass#, List#, SO#).
- Rows have the same shape as the GET above.
- **Columns:** Gate pass#, Date, List#, SO#, Client, Thaans, Driver, Vehicle, Going to, Print button.
