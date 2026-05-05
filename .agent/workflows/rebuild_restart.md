---
description: Rebuild the Vite production bundle and restart the application on port 4005
---

// turbo-all

1. Build the production bundle.
```powershell
npm run build
```

2. Clear any existing processes on port 4005.
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 4005 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
```

3. Start the backend on port 4005.
```powershell
$env:PORT=4005; cmd.exe /c "node server.js"
```
