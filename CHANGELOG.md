# Changelog

## 0.3.1 - 2026-09-13

### Fixed

- Restrict /api/event and /api/interact to localhost origins and reject foreign browser pages, closing a local CSRF vector; CORS no longer uses a wildcard.
- Route the five legacy POST endpoints through readJsonBody so request bodies get the shared 512KB limit and 413 rejection.
- Warn and tighten file permissions when llm.json is readable by other users.
- Declare BrowserWindow contextIsolation/nodeIntegration/sandbox explicitly and deny unexpected window.open.
- Fix garbled message timestamps in LLM group summaries by reusing formatMessageTime.
- Cap the group watcher seen-set with a 5000-entry FIFO queue to stop slow memory growth.
- Compute todo and daily-report boundaries consistently in Asia/Shanghai.
- Validate restored window positions against current display work areas after monitor changes.
- Reject non-numeric /api/archive limit values instead of silently returning the full archive.
- Write the approval cache and message archive atomically (temp file + rename).
- Remove 50 unused shadcn/ui components and trim dependencies from 43 to 9, shrinking the supply-chain surface.
- Add integration tests covering the local server auth matrix.

## 0.3.0 - 2026-07-31

- Upgrade React Router and React to a compatible security-fixed release line.
- Require Node.js 22.22.0 or newer.
- Make render-time initialization deterministic and restore a clean lint gate.
- Refresh the dependency lock and add continuous integration checks.
