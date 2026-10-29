# Vendly

- Phase 1: backend core (`server/`): accounts, wallet ledger, purchases, PIN lock.
- Phase 3: the Vendly screens (`web/index.html`), served by the server and connected to its API. Opened without a server, the page runs in a safe demo mode.
- Phase 4: UI upgrade. Home with service grid, prices and status page, profile, support, notifications, transaction search, "Welcome back" login, and the Vendly brand logo (`brand/` folder has the logo files).
- Phase 5: sign-in and security upgrade. Splash screen, Welcome back login, 4-step secure signup (password strength rules, PIN confirm, consent), change password and PIN, richer profile, hamburger menu, balance-check buttons, last top-up line. Backend now enforces the same password and PIN rules.
- Phase 6: installable app. Install popup, home-screen icon, offline shell (`web/manifest.webmanifest`, `web/sw.js`, `web/icons/`). Needs HTTPS, so it works once the server is live.
- Phase 7: data plans show validity badges (Daily, Weekly, Monthly) with filter chips. Receipts show the validity in the service name.
- Phase 2: server setup (`deploy/`): a free Oracle server that updates itself from this repo.
  Every push is tested on the server first. If the tests fail, the push is rejected and the old version keeps running.

Never put secret keys in this repo. They live on the server in `/etc/vendly.env`.
