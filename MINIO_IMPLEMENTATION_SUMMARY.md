# MinIO in NexusERP: How It Works and Current Implementation

## 1) What MinIO is and how it works

MinIO is an object storage server that exposes an S3-compatible API.

Key concepts:
- Bucket: top-level container for objects.
- Object: a file stored in a bucket, identified by a key (path-like name).
- Access Key and Secret Key: credentials used by clients to authenticate.
- Endpoint: the server URL (for this deployment, built from storage IP and fixed API port 9000).
- Console: management UI (for this deployment, fixed console port 9001).

Typical flow:
1. Client connects to MinIO endpoint with S3 credentials.
2. Client lists or creates buckets.
3. Client uploads object bytes to a selected bucket.
4. Application stores returned metadata or URL for later access.

## 2) How MinIO is represented in this codebase

Configuration model:
- Storage backend types are defined in types.ts:
  - StorageBackend: google-drive or local-storage
  - LocalStorageConfig fields:
    - enabled
    - autoUploadExternalSubmissions
    - storageIp
    - apiPort (default 9000)
    - consolePort (default 9001)
    - accessKey
    - secretKey
    - bucketName

Default values:
- constants.tsx initializes localStorageConfig with:
  - enabled: true
  - autoUploadExternalSubmissions: true
  - apiPort: 9000
  - consolePort: 9001
  - empty storageIp, credentials, and bucketName

Server-side defaults and security:
- server.js merges defaults via resolveSettings, including localStorageConfig.
- localStorageConfig.secretKey is treated as sensitive and encrypted at rest in db.json.

## 3) Backend MinIO integration details

Library used:
- @aws-sdk/client-s3

Client construction in server.js:
- S3Client is built with:
  - endpoint: http://<storageIp>:<apiPort>
  - forcePathStyle: true
  - region: us-east-1
  - credentials from accessKey and secretKey

Implemented backend operations:
- Bucket listing:
  - GET /api/v1/integrations/local-storage/status
  - Returns configured/reachable flags plus buckets array.
- Bucket creation:
  - POST /api/v1/integrations/local-storage/buckets
  - Creates bucket and stores chosen bucketName in settings.
- Object upload:
  - Internal function uploadBufferToLocalStorage
  - Uses PutObjectCommand with selected bucket and computed object key.

Returned local object metadata:
- id: bucketName/objectKey
- name: objectKey
- webViewLink/webContentLink:
  - http://<storageIp>:<apiPort>/<bucketName>/<encodedKey>

## 4) Frontend integration in the ERP

Integrations UI:
- Data Maintenance, Integrations tab supports:
  - Storage backend selector (Google Drive or Local Storage)
  - Local Storage fields: storage IP, username/access key, password/secret key
  - Fixed display for API and console ports
  - Existing bucket dropdown
  - Create new bucket action
  - Enable Integration toggle
  - Auto Upload External Submissions toggle

Frontend service methods in services/dataService.ts:
- getLocalStorageStatus
- createLocalStorageBucket
- uploadExternalSubmission

## 5) Upload behavior currently implemented

Unified upload endpoint:
- POST /api/v1/integrations/storage/upload

Current behavior:
- Upload is independent per integration.
- If Google Drive is enabled and auto-upload is on, it attempts Google upload.
- If Local Storage is enabled and auto-upload is on, it attempts MinIO upload.
- Both can run for the same submission.
- If one fails and the other succeeds, response is still success with partial errors.
- If all enabled targets fail, response is an error.

Order flow usage:
- OrderManagement calls uploadExternalSubmission after order create/update.
- If Google upload succeeds, order fields googleDriveLink/googleDriveFileId/googleDriveFileName are updated.
- Local Storage upload status is shown in user-facing success/info messages.

## 6) Operational notes for your deployment

For your node:
- Storage IP example: 10.11.11.242
- API port: 9000
- Console port: 9001

Requirements for successful Local Storage upload:
- storageIp set correctly
- valid accessKey and secretKey
- selected bucketName (or create one from Integrations UI)
- Local Storage enabled
- Local Storage auto-upload enabled

## 7) Known constraints and current design choices

- The Storage Backend selector in UI controls which configuration panel is shown.
- Upload execution does not depend on selector anymore; it depends on each integration's enabled and auto-upload flags.
- Local object links are generated as direct endpoint URLs and assume network reachability from ERP users/services.
- Google-specific order attachment fields are still the canonical persisted attachment fields in orders.

## 8) Main files involved

- server.js
- components/DataMaintenance.tsx
- components/OrderManagement.tsx
- services/dataService.ts
- types.ts
- constants.tsx
- package.json
