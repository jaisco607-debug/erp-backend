# DEPARTMENTS: previous department's operator + full history; operator required before send

No database change.

## 1. New fields in every row of `GET /departments/:code/incoming` (Job Wise and SO Wise)
```json
"fromOperatorName": "Aslam",
"fromProcessDate": "2026-10-18",
"sentAt": "2026-10-19T08:00:00Z",
"trail": [
  { "jobId": "uuid", "department": "Dyeing",    "jobNo": 18, "operatorName": "Aslam", "processDate": "2026-10-18", "sentAt": "..." },
  { "jobId": "uuid", "department": "Stitching", "jobNo": 19, "operatorName": "Bilal", "processDate": "2026-10-19", "sentAt": "..." },
  { "jobId": "uuid", "department": "Folding",   "jobNo": 20, "operatorName": null,    "processDate": null,         "sentAt": "..." } ]
```
- `fromOperatorName` / `fromProcessDate`: the operator and date of the job in the department that sent the cloth. They are null when the cloth came from the SO card desk.
- `sentAt`: when this job was sent.
- `trail`: the cloth's whole road, oldest first. The last entry is this department itself.

**UI:**
- Add a column "From" showing "Dyeing · Aslam · 18 Oct".
- Add a small "History" icon. It opens a timeline: one line per department, showing Job#, operator, date and sent time.

## 2. Operator required before sending
- `POST /departments/:code/send` (and `POST /jobs` from a department) returns the error **`OPERATOR_REQUIRED`** when a job being sent has no operator name or process date. The message names the Job#, and `details.jobNo` is also sent.
- **UI:**
  - On a Complete row with no operator, show the Send button disabled with the hint "Enter operator first".
  - Or, better, ask for the operator name and date in the send window itself, then call the operator API before sending.
