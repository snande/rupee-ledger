# rupee-ledger

## Backup format

A backup file is JSON written and read entirely on the device; `src/backup-import.js` exports `BACKUP_FORMAT` and `BACKUP_FORMAT_VERSION` for the export to reuse:

```json
{"format":"rupee-ledger-backup","version":1,"exportedAt":"<ISO>","entries":[{"id":"…","amount":120,"text":"chai","category":"Food","createdAt":"<ISO>"}]}
```

`amount` is in rupees (₹). `parseBackup(text)` refuses malformed JSON, a wrong `format`, a missing or unknown `version`, and any entry with a non-numeric, negative, zero or fractional-paisa amount or an invalid `createdAt`. `importEntries(store, entries)` adds, through `addMissingEntries` in `src/ledger/store.js`, only the entries whose `createdAt`, amount and note are not already stored. Ids are per-device, so they are not used to match. Copies are counted, so identical entries in one backup are all kept. It writes them in one readwrite transaction, never deletes or overwrites anything, and resolves to `{ added, skipped }`. `previewImport(store, entries)` reports the same counts without writing.
