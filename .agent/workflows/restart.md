---
description: How to safely restart the NexusERP app on port 3005
---

// turbo-all

1. Clear any existing processes on port 3005.
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 3005 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
```

2. Start the backend on port 3005.
```powershell
$env:PORT=3005; cmd.exe /c "node server.js"
```

> [!IMPORTANT]
> Always keep port 3000 empty as it is reserved for another application.
