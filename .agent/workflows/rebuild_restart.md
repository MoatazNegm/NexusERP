# Rebuild and Restart NexusVSC

The user wants to rebuild the Vite production bundle and restart the application on port 4005 in the `NexusVSC` directory, without any code modifications or testing.

## Proposed Changes

No code changes will be made. The application will be rebuilt with existing local modifications (if any).

## Execution Steps

1. **Rebuild Vite Production Bundle**
   - Run `npm run build` in the `NexusVSC` directory.

2. **Clear Port 4005**
   - Stop any existing process running on port 4005.

3. **Restart Application on Port 4005**
   - Start the backend server using `node server.js` with the `PORT` environment variable set to `4005`.

## Verification Plan

### Manual Verification
- Confirm the commands execute successfully. No functional testing will be performed as per user request.
