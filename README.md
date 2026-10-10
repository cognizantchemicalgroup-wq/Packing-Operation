# CCPL Methanol Operations — Firebase starter

A focused, single-sector operations app for bulk methanol inward, bottling, daily box packing, batch-wise ready stock, and invoice-linked outward dispatch. It uses Firebase Authentication and Cloud Firestore directly; there is no separate application server or SQL database.

## What the starter does

- Live dashboard with bulk kg, filled bottles, packaging balances, ready boxes, and cumulative dispatched invoice kg.
- Bulk methanol and packaging inward against supplier invoice/reference.
- Bottling batch entry: actual bulk kg used, bottles filled/rejected, and production batch number.
- Packing entry: each box uses **4 × 2.5 L bottles, 1 empty box, 2 box plates, and 2 thermocol inserts**. The app validates stock and updates batch and packaging balances atomically.
- Outward entry: sales invoice, party, optional vehicle, one or more source batches, boxes, calculated bottle count/litres, and total kg. Invoice kg can override the nominal volume-to-weight estimate.
- Team activity log: each entry shows the authenticated user and timestamp; authorized users see updates live. The Rupesh admin account can reverse eligible mistaken entries with a recorded reason; source entries remain visible as voided.
- Firebase transaction-based stock updates prevent two users from dispatching or packing more stock than is available.
- CCPL blue interface theme, administrator-provisioned accounts, verified-email access, and password reset flow.
- Admin-only hard reset restricted to `rupesh.mudlar@cognizantchemical.com`, with password reauthentication and an exact typed confirmation phrase. It clears operational stock, batch, sales, and activity records while retaining user access and settings.

## Preview the interface before Firebase setup

Open `interface-preview.html` in a browser to inspect the Dashboard, Daily Packing, Outward / Sales, Stock & Inward, and Activity Log screens. It uses sample figures and local-only controls; it does not connect to or change Firestore.

## Run locally

1. Install Node.js 20 or newer.
2. In Firebase Console, create a project, add a Web App, enable **Authentication → Email/Password**, enable email verification/password-reset email templates, add your hosting domain to Authorized domains, and create **Cloud Firestore**.
3. Copy `.env.example` to `.env.local` and fill in the Firebase Web App configuration values. These client config values identify the Firebase project; they are not Admin SDK secrets.
4. Deploy the Firestore rules from this project with `firebase deploy --only firestore:rules`.
5. Start the app:

   ```bash
   npm install
   npm run dev
   ```

6. Add the local Firebase service-account key as `service-account.json` (or configure Application Default Credentials), then run `npm run provision:users`. The script creates or updates each Firebase Authentication account with a fresh random password, marks the email verified, and creates the matching Firestore profile. It never stores passwords in Firestore. All users must use **Forgot password?** on the login page to set a password before signing in. Running the script again resets all five account passwords, so users must reset them again.

## Deploy to Vercel

Import this project into Vercel from the Git repository and set the **Root Directory** to the folder containing this `package.json` and `index.html` (the repository root if this project is at the top level). The project includes `vercel.json` with the Vite framework, `npm run build` build command, and `dist` output directory.

Add all six Firebase Web App values as Vercel Environment Variables for each environment you deploy (Production, Preview, and Development as applicable):

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

Get these values from the Firebase Console's Web App configuration. They are client-side Firebase configuration, not Firebase Admin credentials. Never add a service-account key or other private credential to Vercel Environment Variables for this frontend. The `service-account.json` file is only for the local user-provisioning script and must remain out of Git and the deployed `dist` output.

The Vercel Git deployment must include `index.html`, `src/main.jsx`, the rest of `src/`, `package.json`, `package-lock.json`, and `vite.config.js`. If Vercel reports that `/src/main.jsx` cannot be resolved while the local build succeeds, check that its Root Directory points to this project folder and that these files are present in the Git commit being deployed.

## Firestore layout

All company data sits under `companies/ccpl/`:

- `users/{uid}` — active status and role (`admin` or `staff`); created for a verified allowlisted email
- `stock/current` — current material balances
- `batches/{batchId}` — bottling batch, accepted bottles, packed boxes, and remaining ready boxes
- `activity/{autoId}` — append-only operational event history
- `sales/{autoId}` — invoice-wise outward records
- `settings/operations` — nominal methanol density used for estimated kg conversion
- `system/maintenance` — short-lived reset lock used to pause stock writes safely during the admin reset

## Approved accounts and admin controls

Only these verified Firebase Authentication email addresses are allowed by both the app and Firestore Rules:

- `rupesh.mudlar@cognizantchemical.com` — administrator, corrections, density settings, hard reset
- `indra@cognizantchemical.com`
- `production@cognizantchemical.com`
- `qa@cognizantchemical.com`
- `anzarsayyed02@gmail.com`

The login page supports password-reset emails but not account creation. Keep the exact allowlist in `src/lib/operations.js`, `firestore.rules`, and `scripts/provision-users.js` in sync if it changes. Firebase Authentication stores passwords securely; never write plaintext passwords to Firestore or source files.

The **Correct / reverse** action is available only to the admin. It retains the original event, records the reason, and reverses stock when dependent stock is still available. If a later operation consumed or dispatched the stock, the app blocks an unsafe reversal.

Hard reset requires the admin password again and the exact phrase `RESET CCPL METHANOL DATA`. It clears stock balances, batches, sales, and activity, then leaves one reset audit record. It retains access accounts and density settings. Confirm the Firebase project and make a backup before using it on live data.

## Important setup and operating notes

- The starter sets a **sample nominal density of 0.792 kg/L** for the estimate. Confirm the correct density basis with CCPL QC and update it in **Stock & Inward → Nominal kg conversion**. If the invoice is billed by weight, enter the actual invoice kg during outward; that value is what the dashboard totals.
- A 2.5 L bottle count and litres are calculated from dispatched boxes. Invoice kg is either the operator's entered value or the density-based estimate; the record stores which source was used.
- To initialize opening stock, enter quantities through inward entries with a clear opening-stock reference before live use. This starter intentionally has no silent balance editing.
- Use a unique production batch number for each bottling run. A dispatch can include multiple batches, each with its own box quantity.
- Firestore client configuration is not a substitute for Firebase Security Rules. Keep the included rules, protect admin accounts, and use Firebase Console backups/export for recovery planning.
- Keep `service-account.json` out of source control and deployment bundles. Restrict access to it and rotate its key in Google Cloud if it has been shared or exposed.
- This is an operational starter, not an accounting/tax invoice generator. Keep statutory invoices in the existing billing system and enter their number and actual kg here for operational reconciliation.

## Before live use

Have the junior developer review permissions and correction workflows, test on a separate Firebase project, and reconcile opening stock against a physical count. Do not test with the production project until the rules and transactions have been verified.
