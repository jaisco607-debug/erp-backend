# Payroll policy: frontend guide (chunk 3)

Written for: the frontend developer (Payroll > Master Card > **Payroll Policy**, and the POLICY button of the payroll sheet).

## 1. What a policy is, and how to lay it out
A policy is the set of rules of one **employee group** (Factory, Outlet, Head Office, Admin, or a group the company made): when someone is late, when it is a half day, the weekly off day, overtime, leave. The payroll and attendance will read these rules later, nothing is calculated here yet.

The policy is kept in **versions**, each with the **month it starts from**:
- A version holds from its month until the next version of the same group. Example: Factory has a version from 2026-07 (late limit 10) and one from 2026-10 (weekly off Friday): September uses the July one, October onward uses the October one.
- A month before the first version, or a group with no version at all, uses the **built-in defaults** (shown as `source: "DEFAULT"`). So every group always has a policy and nothing has to be created first.
- When a payroll is created it will **copy** the policy of its month onto itself, so changing a policy later never changes an old month. That is why a version can be changed or deleted freely.

Suggested screens:
1. **Payroll Policy** (Master Card menu): a month picker (default this month) and a table with one row per group showing the policy in force that month (`GET /payroll/policies/by-group?month=`). Each row has a badge **Default** or **From 2026-07** and an **Edit / Set from a month** button.
2. **Edit** = a form with the 8 rules and a "Starts from" month. If the row is a version, edit it (`PATCH`); if it shows the default, or the user wants a change from a later month, create a new version (`POST`).
3. **History** of a group (`GET /payroll/policies?groupId=`): its versions, newest first, with Edit and Delete.
4. **Payroll sheet, POLICY button**: show the policy of that payroll's month for its group (read only) with `summary` as the one-line text next to the button. Once payrolls exist, the payroll itself will carry its copy; until then use `GET /payroll/policies/effective`.

## 2. Access
Base URL `/api/v1/payroll/policies`. Read: anyone with any payroll service (VIEW is enough). Create / change / delete: service `PAYROLL_EMPLOYEES` with `FULL` (`403` otherwise). Not logged in = `401`. A group or policy of another company is `404`.

## 3. The 8 rules (fields)
| Field | Meaning | Values |
|---|---|---|
| `lateLimitMinutes` | minutes after the shift start up to which the person is still on time; later than this = **L** (late) | whole number 0 to 600 |
| `halfDayLimitMinutes` | minutes after the shift start after which it is a **half day (HD)**. **Must be more than the late limit** | whole number 1 to 1440 |
| `latesPerHalfDay` | how many lates cost half a day of pay | whole number 0 to 31; **0 = lates are never penalised** |
| `weeklyOffDay` | the weekly rest day | `SUNDAY` ... `SATURDAY`, or `null` = no weekly off |
| `overtimeFactor` | multiplier of the overtime pay (1 = normal rate) | number 0 to 10, at most 2 decimals; 0 = no overtime pay |
| `leaveEarnedPerMonth` | leave days earned each month | number 0 to 31, at most 2 decimals |
| `maxLeavePerYear` | the most leave days that can be earned in a year | number 0 to 366, at most 2 decimals |
| `monthsBeforeLeave` | months of service before leave starts to be earned | whole number 0 to 120 |

Send numbers as JSON numbers (not text). Defaults: late 15, half-day 120, 3 lates = half a day, Sunday, overtime x1, leave 2 a month, max 24 a year, after 6 months. Form hints: show the minutes as "15 min", the weekly off as a dropdown with a "No weekly off" entry (`null`).

## 4. A policy as the server answers it
```json
{ "id": "...", "source": "POLICY", "group": { "id": "...", "name": "Factory" }, "effectiveFrom": "2026-10",
  "lateLimitMinutes": 15, "halfDayLimitMinutes": 120, "latesPerHalfDay": 3, "weeklyOffDay": "FRIDAY",
  "overtimeFactor": 1.5, "leaveEarnedPerMonth": 2, "maxLeavePerYear": 24, "monthsBeforeLeave": 6,
  "summary": "Late 15m, half-day 120m, 3 lates = half a day, off Friday, overtime x1.5, leave 2/mo, max 24/yr, after 6 mo",
  "createdAt": "...", "updatedAt": "..." }
```
A default (nothing set): `"source": "DEFAULT", "id": null, "effectiveFrom": null`, the same rules, and `"month"`. Use `source` for the badge and `id` to know whether it can be edited or deleted (`id: null` = nothing to edit: create a version). `summary` is the line for the payroll sheet.

## 5. Calls
| Call | What |
|---|---|
| `GET /policies/by-group?month=2026-10` | the policy in force for **every active group** that month, for the table: `{ month, defaults: {...rules, summary}, data: [ { group: {id, name, isDefault}, policy: {...} } ] }`. `month` is optional (default = this month, Pakistan time). A switched-off group is left out |
| `GET /policies/effective?groupId=...&month=2026-10` | the policy in force for one group and month (same shape as a policy; `month` optional) |
| `GET /policies?groupId=...&page=&limit=` | the versions: `{ data, page, limit, total }`, grouped by group, newest month first |
| `GET /policies/:id` | one version |
| `POST /policies` | a new version from a month (below) |
| `PATCH /policies/:id` | change rules of a version (at least one) |
| `DELETE /policies/:id` | 204; the months it covered fall back to the version before it, or the defaults |

**Create:** `{ "groupId": "...", "effectiveFrom": "2026-10", ...any of the 8 rules }`.
- `effectiveFrom` is a month text `YYYY-MM` (from 2000-01 to 2100-12); it can be in the past or the future.
- **Send only the rules that change.** Every rule not sent is taken from the policy that is in force that month (the earlier version, or the defaults). So "from October the weekly off is Friday" is just `{ groupId, effectiveFrom: "2026-10", weeklyOffDay: "FRIDAY" }`. Pre-fill the form with the policy in force and send what the user changed (or everything, it is fine).
- One version per group and month: a second one for the same month = `422 POLICY_EXISTS` (edit that one).

**Change (PATCH):** only the 8 rules. The group and the month cannot be changed (`400`): to move a policy to another month, create a new version and delete the old one.

## 6. Errors
| status / code | When |
|---|---|
| `400 VALIDATION_FAILED` | a value out of its range, text instead of a number, a month not like `2026-10`, an unknown field, nothing to change |
| `404 NOT_FOUND` | group or policy unknown, or of another company |
| `422 HALF_DAY_NOT_MORE_THAN_LATE` | the half-day limit is not more than the late limit; `details` has both. On an edit the whole policy is checked, so to raise the late limit above the old half-day limit send both in one request |
| `422 POLICY_EXISTS` | the group already has a version from that month |

## 7. Build checklist
1. Master Card menu: **Payroll Policy** (changes only with FULL access; with VIEW show the table read only).
2. Table from `by-group` with a month picker and the Default / From-month badge; Edit opens the form pre-filled from the row.
3. Form: the 8 rules, a "Starts from" month (create only), validation hints (half-day limit above the late limit, ranges); show the server message for 422.
4. History view from `GET /policies?groupId=`; Delete asks for confirmation (old months are not affected).
5. Payroll sheet POLICY button: show `summary` and the rules read only.
6. Test: with no policy every group shows Default; create Factory from 2026-07 with only `lateLimitMinutes: 10`; the table for 2026-06 shows Default, for 2026-09 shows that version; a late limit of 130 with the half-day limit left at 120 is refused.
