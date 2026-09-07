# Tryggsignal.EdgeConnector

Skeleton of the municipal edge connector (masterplan 63, 64, 125).

## Status

`IN_PROGRESS`. `OutboundChannel` and the envelope contract are written; the
source readers (REST, SOAP, SQL read-only view, SFTP, SMB export folder, local
files), the spool store and the Windows Service host are not.

**This project has not been compiled**: no .NET SDK is available in the
environment where it was written. It must be built and tested on a machine with
the .NET 8 SDK before any of it is called verified.

## Install (target state)

```
sc.exe create Tryggsignal.EdgeConnector binPath= "C:\Program Files\Tryggsignal\Tryggsignal.EdgeConnector.exe"
sc.exe config Tryggsignal.EdgeConnector start= auto
```

No Docker. No inbound firewall rule.

## Tests required before P27 may turn GREEN

Offline operation, retry after connectivity loss, corrupted input, service
restart mid-batch, credential expiry.
