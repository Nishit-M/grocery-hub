# Grocery Hub

A shared monthly grocery list for one household, installable on phones as an app.

- **Live data:** Google **Cloud Firestore** (free Spark plan). Changes appear on every phone within a second or two, work offline, and sync when you're back online.
- **Sign-in:** each family member signs in once with their **Google account**. Only emails listed in the **Members** tab of your Google Sheet can open the list.
- **Your Google Sheet stays useful:** every hour, Apps Script copies the app's data into `Master_Items`, `Shopping_List` and `Control`, so **Summary**, **Monthly Spend** and **Staples Status** keep working. They can be up to 1 hour behind. Use **Grocery Hub → Sync now** for an instant update.
- **Hosting:** GitHub Pages (free, HTTPS).

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Your Firebase settings and `APP_VERSION` |
| `manifest.json`, `service-worker.js`, `icons/` | Makes it installable and work offline |
| `firestore.rules` | Database security rules (paste into Firebase) |
| `Code.gs`, `appsscript.json` | Apps Script for the Google Sheet (import, hourly sync, members) |

Upload all of these files to GitHub **except** `Code.gs`, `appsscript.json` and `firestore.rules`. Those three are pasted into Google instead. Uploading them anyway does no harm.

---

## Setup (about 30 minutes, one time)

Use the **same Google account** (the sheet owner) for every step.

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Create a project** → name it `grocery-hub` → turn **Google Analytics off** → **Create**.
2. Note the **Project ID** shown under the project name (e.g. `grocery-hub-3f9a2`). You'll need it twice.

### 2. Create the database
1. Left menu → **Build → Firestore Database** → **Create database**.
2. Location: **asia-south1 (Mumbai)** → **Start in production mode** → **Create**.
3. Open the **Rules** tab → delete everything → paste the whole of `firestore.rules` → **Publish**.

### 3. Turn on Google sign-in
1. Left menu → **Build → Authentication** → **Get started** → **Google** → **Enable** → choose your support email → **Save**.
2. Authentication → **Settings** → **Authorized domains** → **Add domain** → enter `YOUR-GITHUB-USERNAME.github.io` (no `https://`, no path).

### 4. Register the web app
1. Click the ⚙️ gear → **Project settings** → scroll to **Your apps** → click the **`</>`** (Web) icon.
2. Nickname `Grocery Hub` → leave "Firebase Hosting" **unticked** → **Register app**.
3. You'll see a block `const firebaseConfig = { apiKey: "...", authDomain: "...", ... }`. Keep this tab open.

### 5. Fill in `config.js`
Open `config.js` in any text editor and replace the six `PASTE_...` values with the ones from step 4. Keep the quotes. Save.

> The `apiKey` is not a password. It only identifies your project. Security comes from the rules in step 2 and the Members list.

### 6. Set up the Google Sheet script

#### 6a. Paste the code
1. Open your **Grocery Hub** sheet → **Extensions → Apps Script**. This opens the Apps Script editor in a new tab.
2. You'll see a file called `Code.gs` on the left. Click on it, select all the code inside, delete it, and paste the entire contents of this project's `Code.gs`. Press **Ctrl+S** (or ⌘+S) to save.

#### 6b. Add the Firebase project ID
1. In the Apps Script editor, click the ⚙️ **Project Settings** icon in the left sidebar (below the clock icon).
2. Scroll down to **Script Properties** and click **Add script property**.
3. In the **Property** field type `FIREBASE_PROJECT_ID`. In the **Value** field paste your Project ID from step 1 (e.g. `grocery-hub-3f9a2`).
4. Click **Save script properties**.

#### 6c. Replace the manifest file
1. Still in **Project Settings**, tick the checkbox **Show "appsscript.json" manifest file in editor**.
2. Click the **< > Editor** icon in the left sidebar (the top icon) to go back to the code editor.
3. You'll now see `appsscript.json` listed alongside `Code.gs` on the left. Click on `appsscript.json`.
4. Select all its contents, delete them, and paste the entire contents of this project's `appsscript.json`. Press **Ctrl+S** to save.

#### 6d. Run the setup function
1. In the editor toolbar near the top, there is a dropdown that says **Select function**. Open it and choose **setup**.
2. Click the **▶ Run** button next to it.
3. A permissions dialog appears. Click **Review permissions** → choose your Google account.
4. Google will show a warning that the app is "not verified" (this is normal for your own scripts). Click **Advanced** → **Go to Grocery Hub (unsafe)** → **Allow**.
5. Wait for the execution to finish (the log at the bottom will show "Setup complete…").

#### 6e. Verify it worked
1. Go back to your Google Sheet tab and **reload the page** (F5).
2. You should now see:
   - A **Grocery Hub** menu in the menu bar (next to Help).
   - A new **Members** tab at the bottom, with columns Name | Email | Active and 4 placeholder rows. Your email is already filled in row 1.
   - In the **Control** tab, two new headers added to the right: **Monthly Budget** (D1) and **Last App Sync** (E1). The existing **Last Reset** stays in C2.

### 7. Add your family and import your staples
1. In **Members**, type each person's name and the **Gmail / Google account** they'll sign in with. Untick **Active** to remove someone later.
2. Menu **Grocery Hub → Import from sheet (first time only)**. This copies your 129 staples (and any list rows) into the app and lets the members sign in.

> **After the import, the app owns the data.** Add and edit staples in the app (Settings → Manage staples), not in the sheet. Every hour the sheet is overwritten with the app's data. `Master_Items` and `Shopping_List` show a warning if you try to edit them by hand. To add or remove a family member, edit **Members** and choose **Grocery Hub → Push Members tab to app**.

### 8. Put the app on GitHub Pages
1. Sign in at <https://github.com> → **+** → **New repository** → name `grocery-hub` → **Public** → **Create repository**.
2. Click **uploading an existing file** → drag in `index.html`, `styles.css`, `app.js`, `config.js`, `manifest.json`, `service-worker.js`, `README.md` and the **`icons` folder** → **Commit changes**.
3. Repo **Settings → Pages** → Source **Deploy from a branch** → Branch **main** / **(root)** → **Save**.
4. After 1–2 minutes your app is at `https://YOUR-GITHUB-USERNAME.github.io/grocery-hub/`. Open it and tap **Sign in with Google**.

### 9. Install on each phone
- **Android (Chrome):** open the link → ⋮ menu → **Install app** (or tap the "Install app" banner).
- **iPhone (Safari):** open the link → **Share** (□↑) → **Add to Home Screen**. Sign in **after** opening it from the home screen, because the home-screen app keeps its own sign-in.
- **Desktop Chrome / Edge:** click the install icon at the right of the address bar.

### 10. Share
Send the family the link and ask them to sign in with the Google account you put in **Members**.

---

## Updating the app later

1. Edit the file(s), then in `config.js` raise `APP_VERSION` (e.g. `1.0.0` → `1.0.1`).
2. Upload the changed files to GitHub (same names, they overwrite).
3. Phones show **"Update available – Reload"** the next time the app is opened.

If you change `Code.gs`, paste the new version into Apps Script and save. Nothing needs redeploying. If you change `firestore.rules`, paste and **Publish** again.

## Troubleshooting

| You see | Fix |
|---|---|
| "Not on the household list yet" | Add that exact email to **Members** → **Grocery Hub → Push Members tab to app** → tap **Try again**. |
| "This website is not yet allowed…" on sign-in | Add `YOUR-GITHUB-USERNAME.github.io` in Firebase → Authentication → Settings → Authorized domains. |
| Sign-in window doesn't come back on iPhone home-screen app | Close the app fully and try again. If it still fails, see "Firebase Hosting" below. |
| "Almost there – config.js still has placeholder settings" | Step 5 wasn't saved or the old `config.js` is still on GitHub. |
| Apps Script error `403 … Cloud Firestore API has not been used` or `PERMISSION_DENIED` | The script must run as the Google account that **owns** the Firebase project, and `FIREBASE_PROJECT_ID` must match exactly. Open <https://console.cloud.google.com/apis/library/firestore.googleapis.com>, select your project and click **Enable**. |
| Sheet numbers don't match the app | Run **Grocery Hub → Sync now**. The hourly copy can be up to an hour behind. |

**Firebase Hosting (only if iPhone sign-in misbehaves).** Some iPhones block the sign-in pop-up inside home-screen apps when the app and Firebase are on different websites. Hosting the same files on Firebase Hosting (free) puts them on one site. Install Node.js, run `npm i -g firebase-tools`, then `firebase login`, then `firebase init hosting` in the folder (public directory `.`, single-page app: No), then `firebase deploy`. Use the `https://PROJECT-ID.web.app` link instead, and set `authDomain` in `config.js` to `PROJECT-ID.web.app`.

## How the data is stored

| Firestore collection | Sheet tab it's copied to |
|---|---|
| `staples/{Item_ID}`: name, category, qty, unit, status (`Staple`/`Inactive`), sort | `Master_Items` (same order as your original sheet) |
| `list/{List_ID}`: name, category, qty, unit, bought, price, store, dateAdded, addedBy, boughtBy, boughtOn, archived | `Shopping_List` (all rows, archived too) |
| `control/main`: lastReset, budget | `Control!C2`, `Control!D2` |
| `members/{email}`: name, active | filled **from** the `Members` tab |
| `openKeys/{name}`: one per unbought item name | not copied (it's what blocks duplicates across phones) |

- Staples are never deleted, only set to Inactive.
- Totals are always calculated in the app, never stored.
- **History** groups items by the month of **Bought On**, the same as the Monthly Spend tab. Items bought that month but not yet reset are included and marked "in cart", so the History total matches Monthly Spend.
- **Cost:** a household uses a tiny fraction of the free plan (50,000 reads and 20,000 writes per day).

---

## Test checklist (two phones, A and B)

Sign both phones in with two different Members emails.

- [ ] **Sign-in gate:** a Google account not in Members sees "Not on the household list yet".
- [ ] **Add from staples:** on A, Staples tab → tap Onions → it shows "✔ On list" on A **and** appears on B's List within ~2 s.
- [ ] **Duplicate blocked:** on B, + → type "onions" → the warning appears. Submitting scrolls to the existing row. Both phones still show one Onions row.
- [ ] **Simultaneous duplicate:** turn on airplane mode on both phones, add "Coconut" on each, then turn airplane mode off. Only one Coconut remains, and the other phone shows "Already on the list – someone else just added it."
- [ ] **Quantity edit:** tap a row → + / − steps by 0.25 kg, 50 g, 0.5 L, 100 ml or 1 → Save → B updates.
- [ ] **Mark bought and undo:** ✔ moves the item to In Cart. Tap **Undo** in the snackbar within 5 s and it returns. ↩ also moves it back.
- [ ] **Price entry:** In Cart rows without a price are orange. The Missing prices card counts them. Entering a price (e.g. `1,250` or `85.5`) clears the orange, and Cart total / Spent this month update.
- [ ] **Budget:** Settings → set a budget → the bar turns orange above 80% and red above 100%.
- [ ] **Reset:** "Reset Monthly List" asks "Archive N purchased items (₹X)…". After confirming, the cart empties, unbought items stay in grey italics as carried over, and **Undo** brings everything back.
- [ ] **Offline add:** turn on airplane mode on A → the banner reads "Offline – N changes waiting". Add 2 items and mark 1 bought. Close and reopen the app: the changes are still there. Turn airplane mode off and B shows them within seconds.
- [ ] **History matches the sheet:** **Grocery Hub → Sync now** → History for this month shows the same total and per-store split as the **Monthly Spend** row for this month.
- [ ] **Share:** the Share button opens WhatsApp / the share sheet with `*Vegetables*` / `• Onions – 2 kg`.
- [ ] **Install & update:** install on both phones. Raise `APP_VERSION` and re-upload `config.js`. Reopen the app and "Update available – Reload" appears.
