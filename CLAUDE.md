# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Grocery Hub is a shared household grocery list PWA (Progressive Web App). It is a zero-build, plain-JavaScript app — no bundler, no framework, no npm. Files are served directly via GitHub Pages.

## Architecture

### Frontend (the app)

- **`index.html`** — Single HTML page with all screens: loading skeleton, sign-in, denied, setup, and four tabs (List, Staples, History, Settings). Uses `<dialog>` for bottom sheets and confirm modals.
- **`app.js`** — All app logic in one ES module. Imports Firebase SDK directly from CDN (`https://www.gstatic.com/firebasejs/10.14.1/...`). No build step. Key sections are marked with `/* --- section name */` comment blocks.
- **`styles.css`** — Mobile-first CSS with CSS custom properties for theming. Supports light/dark/system themes via `[data-theme]` attribute and `prefers-color-scheme`. Designed for 360px minimum width.
- **`config.js`** — Exposes `self.GH_CONFIG` with Firebase config and `APP_VERSION`. This is the only file that needs editing per deployment.
- **`service-worker.js`** — Precaches the app shell (including Firebase SDK from CDN). Cache-first for app files, network-only for Firestore/auth traffic. Cache name includes `APP_VERSION`.

### Backend (Google Sheet bridge)

- **`Code.gs` + `appsscript.json`** — Google Apps Script bound to a Google Sheet. These files are pasted into the Sheet's Apps Script editor, not deployed from this repo.
- `Code.gs` talks to Firestore via REST API using the sheet owner's OAuth token. Key functions: `setup()`, `importFromSheet()` (one-time), `syncNow()` (hourly trigger copies Firestore → Sheet), `pushMembers()`.

### Data layer

- **Cloud Firestore** (free Spark plan) with offline persistence via `persistentLocalCache` + `persistentMultipleTabManager`.
- Collections: `staples`, `list`, `control`, `members`, `openKeys`.
- `openKeys` is the cross-device duplicate prevention mechanism: one doc per unbought item name; Firestore's `create` semantics reject a second write, blocking simultaneous adds from different phones.
- All writes go through the `commit()` wrapper which tracks `writesInFlight` for sync status display.
- The `members` collection is write-protected from the app (`allow write: if false`); only the Apps Script can modify it.

### Auth

- Google Sign-In via Firebase Auth. The app tries `signInWithPopup` first, falls back to `signInWithRedirect` if popups are blocked.
- Membership is gated by the `members` Firestore collection (populated from the Google Sheet's Members tab).

## Key Conventions

- **No build step** — all files are directly editable and deployable. Do not introduce bundlers, transpilers, or package managers.
- **Firebase SDK version** must match in `app.js` imports and `service-worker.js` `FIREBASE_SDK` constant.
- **`APP_VERSION` in `config.js`** must be bumped for any change to trigger service worker cache invalidation and the "Update available" banner.
- **`keyId()` in `app.js` and `keyId_()` in `Code.gs`** must produce identical output — they encode item name keys for Firestore document IDs.
- Currency is Indian Rupees (INR). Locale is `en-IN`. Timezone is `Asia/Kolkata`.
- HTML escaping uses the `esc()` helper — all dynamic content in `innerHTML` assignments must go through it.
- Staples are never deleted from Firestore, only set to `status: 'Inactive'`.
- Bought list items are never deleted, only archived (`archived: true`).

## Deployment

1. Edit files locally.
2. Bump `APP_VERSION` in `config.js`.
3. Push to GitHub — GitHub Pages serves the updated files.
4. For `Code.gs`/`appsscript.json` changes: paste into the Google Sheet's Apps Script editor.
5. For `firestore.rules` changes: paste into Firebase Console → Firestore → Rules → Publish.

## Firestore Security Rules

Rules are in `firestore.rules`. Key constraints enforced server-side:
- Only verified Google accounts in the `members` collection with `active == true` can read/write.
- `list` items must pass `validItem()` validation (name length, qty > 0, price >= 0, etc.).
- `staples` must pass `validStaple()` and can never be deleted.
- `openKeys` can only be created or deleted (no updates) — this is the duplicate-prevention lock.
- `members` and `control` cannot be deleted from the app.
