# Open an employee's account (Client Admin): frontend guide

Written for: the frontend developer. The "Open account" button on the Employees page.

## Endpoint
`POST /api/v1/users/:id/open` (no body). Only a **client admin** (a normal user gets `403`). Same idea as `POST /companies/:id/open` of the super admin.

## Answer (200)
```json
{
  "accessToken": "...", "tokenType": "Bearer", "expiresIn": "4h",
  "user":     { "id": "<employee id>", "name": "...", "email": "...", "userType": "USER", "...": "..." },
  "company":  { "id": "...", "name": "...", "code": "..." },
  "services": [ { "code": "FOLDING", "access": "VIEW" } ]
}
```
- The token is the **employee's**: `user` and `services` are exactly the employee's own, so the admin sees what the employee sees.
- Valid for **4 hours**. There is **no refresh token**: when it expires (401) the admin logs in again. Keep the admin's own session safe somewhere so "Back to my account" works.
- Use `accessToken` as `Authorization: Bearer ...` for every call while the employee's account is open.

## Errors
| status / code | When |
|---|---|
| `403` | the caller is not a client admin |
| `404 NOT_FOUND` | unknown id, an employee of another company, or another client admin's id |
| `422 CANNOT_OPEN_SELF` | the id is the caller's own id |
| `422 USER_INACTIVE` | the employee is switched off (message: "This user is switched off: switch it on first") |

## What the opened session can and cannot do
- It can do what the employee's services allow; it cannot manage users (`/users...` answers `403`).
- `POST /auth/change-password` and `POST /auth/logout-all` answer `422 ACCOUNT_OPENED_BY_ADMIN` (the admin must not change the employee's password or end their sessions from there).
- The session ends at once if the admin logs out everywhere or changes their password, and when the employee is switched off.
- Audit: an entry `USER_OPENED` (who opened whom, when). Every change made in the session is recorded with the employee as the actor and the admin's email in the actor text, e.g. `ali@test.com (via client admin admin@test.com)`.
- A super admin who opened a company can also use this button: the super admin stays the one behind the token.

## Checklist
1. Employees page, button **Open account** -> call the endpoint -> store `accessToken` (and the admin's own token) -> go to the employee's dashboard built from `services`.
2. Show a banner "Viewing as <name>" with a **Back** button that restores the admin's own token.
3. On 401 while opened, return to the login screen.
