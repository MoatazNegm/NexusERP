# QualityCheck REST API & AI Agent Integration Guide

Welcome to the QualityCheck API documentation. This API is designed to allow automated AI agents, test runners, and developer scripts to perform **all** testing and management actions that can be done in the web UI.

---

## 1. Interactive Swagger UI & OpenAPI Specification

- **Interactive Swagger Documentation**: [http://localhost:4006/api/docs](http://localhost:4006/api/docs)
- **Machine-Readable OpenAPI 3.0 JSON**: [http://localhost:4006/api/openapi.json](http://localhost:4006/api/openapi.json)

You can explore endpoints and run live API requests directly using Swagger UI with your generated API key.

---

## 2. Authentication & API Key Management

The admin can generate API keys directly in the **Admin Panel → Settings → API Key Management** section.

### How to Authenticate
When calling any API endpoint, pass your API key in **one** of the following ways:

1. **Header (Recommended)**:
   ```http
   X-API-Key: qc_your_api_key_here
   ```
2. **Bearer Token**:
   ```http
   Authorization: Bearer qc_your_api_key_here
   ```
3. **Query Parameter**:
   ```http
   GET /api/tests?api_key=qc_your_api_key_here
   ```
4. **Log On via API Key to Obtain Web / JWT Session (`POST /api/auth/login`)**:
   Users and automated clients can log on directly using their generated key to obtain a standard authenticated web session and cookies:
   ```http
   POST /api/auth/login
   Content-Type: application/json

   {
     "apiKey": "qc_your_api_key_here"
   }
   ```
   *Note: Generated keys are designed for automated test agents, CLI tools, and REST clients using the `X-API-Key` header or REST login endpoint. The web dashboard login screen is reserved for username/password authentication.*

### User Attribution & Valid Names
When generating an API key, the admin assigns a valid name (or selects an existing user). Every action performed with this key (submitting results, uploading evidence, creating tests, earning points) is attributed to this user across the entire system (reports, test submissions, audit trails, and points ledger).

### Check Your Identity (`/api/api-keys/me`)
Verify your credentials and check who you are authenticated as:

```bash
curl -X GET http://localhost:4006/api/api-keys/me \
  -H "X-API-Key: qc_your_api_key_here"
```

**Response (200 OK):**
```json
{
  "authenticated": true,
  "user": {
    "userId": 3,
    "username": "AI_Agent_01",
    "isAdmin": false,
    "userGroups": ["testers"],
    "role": "tester",
    "isApiKey": true,
    "apiKeyName": "Automated QA Agent Alpha"
  }
}
```

### Key Revocation & Re-issuance Policy
- **Revoking a key does NOT delete the user**: When an administrator revokes a key, only the key is invalidated. The user account, assignments, historical results, and earned points remain fully preserved.
- **Immediate session termination**: The user will immediately be blocked from logging on with the revoked key, and any existing active sessions will be terminated on their next request.
- **Re-issuance**: Administrators can generate a new key for the user at any time (from the Admin Panel Users tab or API Keys tab). The user can then immediately log on with their new key.

---

## 3. Tester & AI Agent Workflow

An AI testing agent typically executes the following workflow:

```
[1. GET /api/tests/active] -> Discover current active test
       ↓
[2. GET /api/test-results/{testId}/next] -> Get next unattempted step
       ↓
[Execute Step Instructions & Inspect System]
       ↓
[3. POST /api/test-results/{testId}/steps/{stepId}] -> Submit result (pass/fail or yes/no)
       ↓
[Repeat until test is done]
       ↓
[4. POST /api/tests/{testId}/complete] -> Advance testing cycle to next test
```

---

### 3.1 List Assigned Tests
```bash
curl -X GET "http://localhost:4006/api/tests?appId=all" \
  -H "X-API-Key: qc_your_api_key_here"
```
Or specify a specific application via query param or header:
```bash
curl -X GET "http://localhost:4006/api/tests?appId=1" \
  -H "X-API-Key: qc_your_api_key_here"
# or
curl -X GET http://localhost:4006/api/tests \
  -H "X-API-Key: qc_your_api_key_here" \
  -H "X-App-Id: all"
```
Returns assigned tests with execution and loop status (`isActive`, `locked`, `completed`, `monthlyRounds`, `totalPoints`) along with application identity (`app_id`, `app_name`).

- **Multi-App Scope**: Passing `?appId=all` or `X-App-Id: all` returns all tests across all applications assigned to the user (or all applications for administrators).
- **Role Permissions**:
  - **Testers**: Automatically assigned to their current loop-active test; non-active tests are locked (`locked: true`).
  - **Developers & Admins**: Can start and execute any assigned test at any time (`locked: false`).

> **Note on Maximum Rounds per Test:** Automated processes and AI test runners calling the API with an API key are **completely exempt** from monthly maximum round limitations (`max_monthly_test_rounds`). Tests will never be locked due to monthly attempt counts when executing via API key.

---

### 3.2 Get the Currently Active Test (`/api/tests/active`)
Returns the unlocked test that the agent should execute in the current testing cycle:

```bash
curl -X GET http://localhost:4006/api/tests/active \
  -H "X-API-Key: qc_your_api_key_here"
```

**Response (200 OK):**
```json
{
  "activeTest": {
    "id": 5,
    "name": "User Registration & Onboarding",
    "description": "Verifies account creation and verification emails",
    "steps": [
      {
        "id": 21,
        "test_id": 5,
        "step_number": 1,
        "description": "Navigate to /register and fill in username and password",
        "success_symptom": "Form renders cleanly and validation indicators show green",
        "points": 10,
        "value": 10,
        "on_failure": "stop",
        "attachment_path": null,
        "attachment_name": null
      }
    ]
  }
}
```

---

### 3.3 Get Next Unattempted Step (`/api/test-results/{testId}/next`)
Fetches the first unattempted step in the test for the authenticated agent:

```bash
curl -X GET http://localhost:4006/api/test-results/5/next \
  -H "X-API-Key: qc_your_api_key_here"
```

---

### 3.4 Submit Test Result (`POST /api/test-results/{testId}/steps/{stepId}`)

Supports:
- Result values: `'pass'`, `'fail'`, `'yes'`, `'no'` (case-insensitive).
- Optional comments.
- Evidence attachment: via direct file upload (`multipart/form-data`) OR JSON base64 (`fileData`).

#### Option A: Submit via JSON (Clean & Simple for AI Agents)
```bash
curl -X POST http://localhost:4006/api/test-results/5/steps/21 \
  -H "X-API-Key: qc_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "result": "pass",
    "comment": "Verification succeeded. Response time was 85ms."
  }'
```

#### Option B: Submit via JSON with Base64 Screenshot/Log
```bash
curl -X POST http://localhost:4006/api/test-results/5/steps/21 \
  -H "X-API-Key: qc_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "result": "fail",
    "comment": "Element #submit-btn timed out after 5000ms",
    "fileData": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "fileName": "timeout_error.png"
  }'
```

#### Option C: Submit via Multipart Form Data with File
```bash
curl -X POST http://localhost:4006/api/test-results/5/steps/21 \
  -H "X-API-Key: qc_your_api_key_here" \
  -F "result=pass" \
  -F "comment=All tests passed" \
  -F "configFile=@/path/to/log.txt"
```

**Response (200 OK):**
```json
{
  "id": 142,
  "submissionId": 358,
  "roundId": 1,
  "result": "pass",
  "pointsAwarded": 10,
  "configFilePath": "/uploads/configFile-u3-t5-s21-1710000000.png",
  "message": "Result submitted successfully",
  "autoEnded": false,
  "warning": null
}
```

> **Note on Consecutive Failures**: If a tester fails steps rapidly across different tests (under the configured threshold, e.g. 3 minutes), points are zeroed out and a warning is logged explaining the withhold.

---

### 3.5 Standalone File Upload (`POST /api/upload`)
Upload log files, crash dumps, or screenshots independently:

```bash
curl -X POST http://localhost:4006/api/upload \
  -H "X-API-Key: qc_your_api_key_here" \
  -F "file=@/path/to/evidence.zip"
```

Or with JSON:
```bash
curl -X POST http://localhost:4006/api/upload \
  -H "X-API-Key: qc_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "system.log",
    "fileData": "U3lzdGVtIGV2ZW50IGxvZw==",
    "mimeType": "text/plain"
  }'
```

**Response (201 Created):**
```json
{
  "success": true,
  "filePath": "/uploads/upload-u3-1710000000.log",
  "filename": "upload-u3-1710000000.log",
  "originalName": "system.log",
  "fileSize": 16,
  "mimeType": "text/plain"
}
```

---

### 3.6 Complete Test (`POST /api/tests/{testId}/complete`)
When all non-section steps are finished, mark the test as complete to advance the loop:

```bash
curl -X POST http://localhost:4006/api/tests/5/complete \
  -H "X-API-Key: qc_your_api_key_here"
```

---

### 3.7 End Test Early (`POST /api/tests/{testId}/end`)
If a hard-stop failure occurs or the agent needs to end the test early:

```bash
curl -X POST http://localhost:4006/api/tests/5/end \
  -H "X-API-Key: qc_your_api_key_here"
```

---

### 3.8 Restart / Re-activate Test (`POST /api/tests/{testId}/activate`)
```bash
curl -X POST http://localhost:4006/api/tests/5/activate \
  -H "X-API-Key: qc_your_api_key_here"
```

---

### 3.9 Revert Step Result (`DELETE /api/test-results/{testId}/steps/{stepId}`)
Reverts the result and deducted/earned points for a step in the current round:

```bash
curl -X DELETE http://localhost:4006/api/test-results/5/steps/21 \
  -H "X-API-Key: qc_your_api_key_here"
```

---

### 3.10 Metrics, Warnings & History
- **Points Summary**: `GET /api/test-results/summary`
- **Warnings**: `GET /api/test-results/warnings`
- **History**: `GET /api/test-results/history`

---

## 4. Developer & Admin API: Test Authoring & Management

Developers and Admins can programmatically manage tests, steps, attachments, versions, and imports.

### 4.1 Create a Test (`POST /api/tests`)
```bash
curl -X POST http://localhost:4006/api/tests \
  -H "X-API-Key: qc_developer_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Order Fulfillment Service",
    "description": "Verifies order processing, payment capture, and dispatch"
  }'
```

### 4.2 Add Step to Test (`POST /api/tests/{id}/steps`)
```bash
curl -X POST http://localhost:4006/api/tests/5/steps \
  -H "X-API-Key: qc_developer_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "step_number": 1,
    "description": "Send POST request to create an order",
    "success_symptom": "Status 201 Created with order ID",
    "points": 15,
    "on_failure": "stop"
  }'
```

### 4.3 Update Step (`PUT /api/tests/{testId}/steps/{stepId}`)
```bash
curl -X PUT http://localhost:4006/api/tests/5/steps/21 \
  -H "X-API-Key: qc_developer_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "step_number": 1,
    "description": "Updated step description",
    "success_symptom": "Updated success symptom",
    "points": 20,
    "on_failure": "continue"
  }'
```

### 4.4 Delete Step (`DELETE /api/tests/{testId}/steps/{stepId}`)
```bash
curl -X DELETE http://localhost:4006/api/tests/5/steps/21 \
  -H "X-API-Key: qc_developer_api_key"
```

### 4.5 Reorder Steps (`PUT /api/tests/{testId}/steps/reorder`)
```bash
curl -X PUT http://localhost:4006/api/tests/5/steps/reorder \
  -H "X-API-Key: qc_developer_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "stepOrder": [
      { "id": 21, "step_number": 1 },
      { "id": 22, "step_number": 2 }
    ]
  }'
```

### 4.6 Upload Reference Attachment for a Step (`POST /api/tests/{testId}/steps/{stepId}/attachment`)
```bash
curl -X POST http://localhost:4006/api/tests/5/steps/21/attachment \
  -H "X-API-Key: qc_developer_api_key" \
  -F "file=@/path/to/expected_output.json"
```

### 4.7 Import Tests from Excel or CSV (`POST /api/tests/import`)
Supports importing Excel (.xlsx) workbooks or CSV files:
```bash
curl -X POST http://localhost:4006/api/tests/import \
  -H "X-API-Key: qc_developer_api_key" \
  -F "file=@/path/to/TestSuite.xlsx"
```
Or via JSON with base64 file data:
```bash
curl -X POST http://localhost:4006/api/tests/import \
  -H "X-API-Key: qc_developer_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "TestSuite.xlsx",
    "fileData": "<base64_encoded_file>"
  }'
```

### 4.8 Disable / Enable Tests
- **Disable Test**: `DELETE /api/tests/{id}` or `POST /api/tests/{id}/disable`
- **Enable Test**: `POST /api/tests/{id}/enable`
- **Enable All Tests**: `POST /api/tests/enable-all`

---

## 5. API Keys Administration API

Only administrators can create or revoke API keys.

### 5.1 Generate an API Key (`POST /api/api-keys`)
```bash
curl -X POST http://localhost:4006/api/api-keys \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Automated AI Regression Bot",
    "role": "tester",
    "userName": "AI_Regression_Bot"
  }'
```

**Response (201 Created):**
```json
{
  "message": "API key created successfully. Please copy it now as it will not be displayed again.",
  "key": "qc_e1a4f028b17c8d92...",
  "apiKey": {
    "id": 4,
    "name": "Automated AI Regression Bot",
    "key_prefix": "qc_e1a4f028...",
    "role": "tester",
    "user_id": 8,
    "username": "AI_Regression_Bot",
    "is_active": 1,
    "created_at": "2026-10-07T12:00:00.000Z"
  }
}
```

### 5.2 List API Keys (`GET /api/api-keys`)
```bash
curl -X GET http://localhost:4006/api/api-keys \
  -H "Authorization: Bearer <admin_token>"
```

### 5.3 Toggle API Key Status (`PATCH /api/api-keys/{id}/toggle`)
```bash
curl -X PATCH http://localhost:4006/api/api-keys/4/toggle \
  -H "Authorization: Bearer <admin_token>"
```

### 5.4 Revoke an API Key (`DELETE /api/api-keys/{id}`)
Revokes and deletes the generated API key. **The associated user account, test assignments, and testing records are preserved.** The user will immediately be unable to logon or authenticate with the revoked key, and any active browser sessions are terminated.
```bash
curl -X DELETE http://localhost:4006/api/api-keys/4 \
  -H "Authorization: Bearer <admin_token>"
```

**Response (200 OK):**
```json
{
  "message": "API key \"Automated AI Regression Bot\" revoked successfully. The user account has been preserved and can be issued a new key later.",
  "user_id": 8
}
```

### 5.5 Revoke All Keys for a User (`DELETE /api/users/{id}/revoke-key`)
Revokes all active keys for a specific user without removing their account:
```bash
curl -X DELETE http://localhost:4006/api/users/8/revoke-key \
  -H "Authorization: Bearer <admin_token>"
```

### 5.6 Generate / Re-issue a Key for a User (`POST /api/users/{id}/generate-key`)
Issues a new generated key for an existing user:
```bash
curl -X POST http://localhost:4006/api/users/8/generate-key \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated-Tester-Key",
    "role": "tester"
  }'
```

### 5.7 List Keys for a Specific User (`GET /api/users/{id}/keys`)
Lists all API keys associated with a specific user:
```bash
curl -X GET http://localhost:4006/api/users/8/keys \
  -H "Authorization: Bearer <admin_token>"
```

---

## 6. Admin REST API Reference

When authenticated with an admin API key (`X-API-Key: qc_...` with role `admin`) or a JWT Bearer token (`Authorization: Bearer <token>` for an admin user), administrators and automated systems can perform all administrative operations programmatically.

### 6.1 User Management

#### List All Users
```http
GET /api/users
```
Returns a list of all registered users, their roles, suspension status, assigned groups (`testers`, `developers`, `admins`), and their active generated keys (`api_keys`).

#### Bulk User Summaries
```http
GET /api/users/summaries
```
Returns aggregate test execution statistics (assigned count, completed tests count, hard-stop failures, completed cycles) for all users in one fast response.

#### Get User Profile & Stats
```http
GET /api/users/{id}
```
Returns user details along with their current execution metrics: `completedRounds`, `assignedTestsCount`, and `totalPointsEarned`.

#### Create / Provision User
```http
POST /api/users
Content-Type: application/json

{
  "username": "john_tester",
  "password": "SecurePassword123!",
  "isAdmin": false,
  "user_groups": ["testers"]
}
```
*Note: Newly created testers are automatically assigned all active system tests.*

#### Update User Details & App Assignments
```http
PUT /api/users/{id}
Content-Type: application/json

{
  "username": "john_tester_updated",
  "isAdmin": false,
  "user_groups": ["testers", "developers"],
  "appIds": [1, 2]
}
```
`appIds` assigns or reassigns the application suites the user has permission to test and view.

#### Suspend or Reactivate User
```http
PUT /api/users/{id}/suspend
Content-Type: application/json

{
  "is_suspended": 1
}
```
*(Set `0` to reactivate).*

#### Reset User Password
```http
PUT /api/users/{id}/password
Content-Type: application/json

{
  "newPassword": "BrandNewPassword123!"
}
```

#### List User Keys
```http
GET /api/users/{id}/keys
```
Returns all API keys linked to user `{id}`, including key prefix, role, active status, creation date, and last used timestamp.

#### Generate / Re-issue User Key
```http
POST /api/users/{id}/generate-key
Content-Type: application/json

{
  "name": "QA-Runner-Key",
  "role": "tester"
}
```
Generates a new secure key for user `{id}`. Returns the raw key (`qc_...`) to share with the user or automated runner.

#### Revoke User Key(s) (Preserves User Account)
```http
DELETE /api/users/{id}/revoke-key
```
Revokes all active keys for user `{id}` and terminates any active sessions. **The user profile, assigned tests, round state, and test history remain intact.** The admin can generate another key for this user later.

#### Payout / Deduct Points
```http
POST /api/users/{id}/pay-points
Content-Type: application/json

{
  "pointsToPay": 500,
  "note": "October QA incentive payout"
}
```

#### Delete User (Cascade Wipe)
```http
DELETE /api/users/{id}
```
Permanently removes the user and cascades cleanup across test results, assignments, and points records.

---

### 6.2 Reporting Endpoints

All reporting endpoints accept optional date filters (`startDate`, `endDate` in `YYYY-MM-DD` format) and `versionIds` (comma-separated or multiple parameters).

#### User Performance Report
```http
GET /api/reports/user-report?userId=10,11,12&startDate=2026-10-01&endDate=2026-10-31&versionIds=13
```
Detailed breakdown of user tests, completed rounds, pass/fail steps, and awarded points. Supports single user ID or comma-separated user IDs.

#### Test Execution Report
```http
GET /api/reports/test-report?testId=1,2,3&startDate=2026-10-01&endDate=2026-10-31
```
Execution breakdown per test case, step success rates, and tester comments.

#### Passed Tests Report
```http
GET /api/reports/passed-report?startDate=2026-10-01&endDate=2026-10-31
```
List of test executions where all steps passed without hard-stops or failures.

#### Failed Tests Report
```http
GET /api/reports/failed-report?startDate=2026-10-01&endDate=2026-10-31
```
Audit of failed test runs, including blocking step descriptions, tester comments, and failure timestamps.

#### Points Ledger Report
```http
GET /api/reports/points?startDate=2026-10-01&endDate=2026-10-31
```
Ledger breakdown of all awarded points by user, test run, step, and activity type.

#### Points Payment History
```http
GET /api/reports/points-payments?userId=10
```
Audit history of points paid out, cash equivalent values, and admin payment notes.

#### System Monthly Financials
```http
GET /api/reports/monthly
```
System-wide monthly financial breakdown and completed testing cycles across all testers.

#### Tester Monthly Financials
```http
GET /api/reports/monthly/{userId}
```
Detailed monthly financial calculations, threshold targets, bonus tiers, and cycle completions for a single tester.

---

### 6.3 Test & Assignment Management

#### View All Test Assignments (Bulk)
```http
GET /api/tests/assignments/bulk
```
Returns a complete map of tests and their assigned user IDs: `{ [testId]: [userId1, userId2] }`.

#### Assign User(s) to a Test
```http
POST /api/tests/{id}/assignments
Content-Type: application/json

{
  "userIds": [10, 11]
}
```

#### Remove User Assignment from a Test
```http
DELETE /api/tests/{id}/assignments/{userId}
```

#### Disable a Test Case
```http
POST /api/tests/{id}/disable
```
Disables the test case so it is bypassed in all active testing cycles.

#### Enable a Test Case
```http
POST /api/tests/{id}/enable
```

#### Enable All Tests in Bulk
```http
POST /api/tests/enable-all
```

#### Get Test Details & Steps
```http
GET /api/tests/{id}
```
Returns full test details, prerequisites, and all defined test steps.

---

### 6.4 System Settings

#### Get System Settings
```http
GET /api/settings
```
Retrieves all active configuration key-value pairs (points per round, thresholds, Dropbox tokens, etc.).

#### Update Settings (Single or Batch)
```http
PUT /api/settings
Content-Type: application/json

{
  "settings": {
    "points_per_test": 150,
    "monthly_target_rounds": 10
  }
}
```
*(Also supports single key updates: `{ "key": "points_per_test", "value": 150 }`).*

#### Test Dropbox Integration
```http
POST /api/settings/test-dropbox
```
Validates the configured Dropbox access token and checks upload folder permissions.

---

### 6.5 Backup & Restore

#### Export Full Database Backup
```http
GET /api/backup/export
```
Returns a complete, timestamped JSON snapshot of the entire database schema and data (`application/json`).

#### Restore Database Backup
```http
POST /api/backup/import
Content-Type: multipart/form-data

file: <qualitycheck_backup_xxxx.json>
```
Restores database tables, tests, users, and audit records from a previously exported backup file.

---

### 6.6 Release Version Management

#### List Release Versions
```http
GET /api/versions
```
Returns all release versions with their active status and creation timestamps.

#### Create Release Version
```http
POST /api/versions
Content-Type: application/json

{
  "version_number": "v2.5.0",
  "description": "October 2026 Release"
}
```

#### Set Current Active Version
```http
POST /api/versions/{id}/set-current
```
Activates the version as the default system version for incoming test runs.

#### Delete Release Version
```http
DELETE /api/versions/{id}
```
Deletes a release version (only permitted if no test results or points are attached to it).

---

### 6.7 Application Management & Multi-Tenant Isolation

> [!IMPORTANT]
> **Strict Multi-Tenant Application Isolation:**
> - **Global System Administrator (`admin`)**: Possesses system-wide multi-app privileges. Can list all apps, create new apps, suspend, archive, and view multi-application reports.
> - **App-Scoped Users & API Keys**: When a key or user is created inside an application, they are permanently locked to that application's scope (`app_id`).
> - **Zero-Visibility Boundary**: Scoped users and keys have zero visibility into other applications. `GET /api/apps` returns ONLY their assigned apps. Querying or submitting to another application (e.g., via `X-App-Id` or `?appId=`) returns `403 Forbidden: You do not have access to this application`.
> - **Application Lifecycle**: Only the global administrator can create (`POST /api/apps`), suspend (`PATCH /api/apps/:id/suspend`), or archive (`DELETE /api/apps/:id`) applications.

#### List Applications
```http
GET /api/apps
```
*Returns all active applications for the global admin, or strictly the caller's assigned applications for app-scoped users and API keys.*

Query parameters:
- `includeArchived=true` or `archived=true`: Include soft-deleted/archived applications (global admin only).

#### Create Application (Global Admin Only)
```http
POST /api/apps
Content-Type: application/json

{
  "name": "BillingPortal",
  "description": "Billing and invoicing microservices"
}
```

#### Update Application
```http
PUT /api/apps/{id}
Content-Type: application/json

{
  "name": "BillingPortal v2",
  "description": "Updated billing portal suite"
}
```

#### Suspend / Reactivate Application
```http
PATCH /api/apps/{id}/suspend
Content-Type: application/json

{
  "is_suspended": 1
}
```
*(Set `0` to reactivate. Suspended apps remain visible in administrative reports, but users cannot log in to work on them).*

#### Archive Application (Soft-Delete)
```http
DELETE /api/apps/{id}
```
Safely archives the application without deleting historical test results, rounds, points, or audit records. The application is moved to the archive and excluded from active user sessions.

#### Restore Archived Application
```http
POST /api/apps/{id}/restore
```
Restores an archived application back to active status.

---

## 7. Python Integration Example

Here is a ready-to-run Python script for an AI testing agent:

```python
import requests
import json
import base64

API_BASE = "http://localhost:4006/api"
API_KEY = "qc_your_api_key_here"
HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

def run_agent():
    # 1. Verify caller identity
    me = requests.get(f"{API_BASE}/api-keys/me", headers=HEADERS).json()
    print(f"Logged in as: {me['user']['username']} (Role: {me['user']['role']})")

    # 2. Get active test
    res = requests.get(f"{API_BASE}/tests/active", headers=HEADERS).json()
    active_test = res.get("activeTest")
    if not active_test:
        print("No active test available.")
        return

    test_id = active_test["id"]
    print(f"Executing Test: {active_test['name']} (ID: {test_id})")

    # 3. Step execution loop
    while True:
        step_res = requests.get(f"{API_BASE}/test-results/{test_id}/next", headers=HEADERS)
        if step_res.status_code == 404:
            print("All steps completed!")
            break

        step = step_res.json()["step"]
        step_id = step["id"]
        print(f"\nStep {step['step_number']}: {step['description']}")
        print(f"Expected Symptom: {step['success_symptom']}")

        # Simulate execution or run automated checks
        # Result can be 'pass' / 'fail' or 'yes' / 'no'
        result = "yes"
        comment = "Automated verification completed successfully."

        sub_res = requests.post(
            f"{API_BASE}/test-results/{test_id}/steps/{step_id}",
            headers=HEADERS,
            json={"result": result, "comment": comment}
        ).json()
        print(f"-> Submitted: {sub_res['result']} (Points awarded: {sub_res.get('pointsAwarded', 0)})")

        if sub_res.get("autoEnded"):
            print("Test auto-ended due to stop condition.")
            break

    # 4. Mark test complete
    complete_res = requests.post(f"{API_BASE}/tests/{test_id}/complete", headers=HEADERS).json()
    print(f"Test cycle complete: {complete_res.get('message')}")

if __name__ == "__main__":
    run_agent()
```
