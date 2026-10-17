# Pathfinder setup

The Pathfinder browser app uses Firebase Authentication for account creation,
sign-in, sign-out, password reset, and account password changes. You do not
need to install Node.js, run `npm install`, or use `npm start` to use the
Firebase frontend.

## Optional PostgreSQL API backend

The API backend is started with `npm start` (development: `npm run dev`). It
uses PostgreSQL and JWT authentication. Before starting it, configure
`DATABASE_URL_POOLED` (or `DATABASE_URL`) and `JWT_SECRET` in a local `.env`
file using `.env.example` as a guide. The database URL must point to a
non-local PostgreSQL service. Never commit `.env` or place credentials in
source files.

The existing browser pages continue to use Firebase directly; they do not yet
call this API. `npm test` still covers the retained SQLite implementation and
does not validate the PostgreSQL API.

## Run the app

1. Open this folder in Visual Studio Code.
2. Start the pages with the Live Server extension (do not open the HTML files
   directly with `file://`).
3. Open the login page at
   `http://127.0.0.1:5500/.vscode/login.html`, or use the port shown by Live
   Server.

Staff can sign in from this page. Supervisors and administrators can also use
`/.vscode/admin-login.html`; it verifies the Firestore role before opening the
dashboard. New self-registered profiles always receive the `technician` role.

## Enable Firebase sign-in

The Firebase web configuration is in `.vscode/firebase-config.js`. It is
intended for browser use; never put a Firebase service-account key or other
private server credential in that file.

In the Firebase console for the configured project:

1. Open **Authentication** and choose **Get started** if prompted.
2. Under **Sign-in method**, enable **Email/Password**.
3. Under **Settings**, add the host used by Live Server to **Authorized
   domains** (for example, `127.0.0.1` or `localhost`; do not include the port).

If sign-in reports that authentication is not enabled or the domain is not
authorized, those Firebase console settings need to be updated. The app cannot
enable Firebase Authentication on the project's behalf.

## Account features

- New users can sign up with their name, email, and a password of at least six
  characters.
- Users can change their display name or update their password in **My
  account**. Changing a password requires the current password.
- Administrators can manage roles on the **Users** page. Staff self-register
  with the `technician` role; an administrator can later assign
  `supervisor` or `administrator`. Role changes are recorded in the audit log.
  For safety, administrators must ask another administrator to change their
  own role.
- **Forgot password?** sends a reset email through Firebase. Firebase must be
  configured to send account emails.
- The theme switch appears only after a user is signed in.

## Performance notes

- The shared dashboard shell is initialized by a small local script, so the
  sidebar and page heading do not wait for Firebase Authentication to finish
  loading. Authentication checks still run on every protected page.
- Poppins loads asynchronously after the initial render. The app shows its
  existing system font fallback first, then switches to Poppins when Google
  Fonts is available.
- Dashboard links prefetch their HTML when a user points to or tabs to a
  destination. Sign out is deliberately excluded; normal page navigation and
  Firebase checks remain in place.
- Inventory, fault history, alerts, reports, user roles, audit history, and
  dashboard totals are loaded from Firestore. Lists load in pages of 50 rather
  than downloading every document. Reports fetch all selected records only
  after an export is requested.

The Express/SQLite files from the earlier implementation are retained but are
not started by the current `start` script. The browser app continues to use
Firebase directly.

## Log component events

## Firestore setup and roles

Create a Firestore database for the Firebase project in
`.vscode/firebase-config.js`, then deploy the rules and index in this folder.
With the Firebase CLI installed and configured for the same project, run:

```text
firebase deploy --only firestore:rules,firestore:indexes
```

Alternatively, publish `firestore.rules` in **Firestore Database → Rules** and
create the composite index described by `firestore.indexes.json`. Until the
rules are deployed, Firestore denies access.

New sign-ups receive the `technician` role automatically. To provision the
first administrator securely, create the account through Pathfinder, copy its
Firebase Authentication UID, and create a `users/{uid}` document in the
Firebase console with its email, display name, role `administrator`, and a
timestamp `createdAt`. Do not use example passwords from project documents or
put administrator credentials in source code. Administrators can then assign
roles from **Users**; the role change and audit entry are committed together.

The application uses these Firestore collections:

- `components`: component ID, type, unique serial number, manufacturer/model,
  purchase and warranty dates, expected service life, current kiosk, and
  status. Component IDs are document IDs; newly registered assets start in
  storage.
- `componentSerials`: immutable serial-number reservations created atomically
  with a component, preventing two newly registered components from sharing
  the same serial number.
- `kiosks`: kiosk ID, location, installation date, and active/inactive status.
  Kiosk registration and configuration are administrator-only.
- `events`: immutable move, install, removal, decommission, maintenance, and
  fault history. Assignment changes and their event record are validated in a
  single Firestore transaction.
- `faults`: reported issue, severity, reporter, and status. Reports are linked
  to asset history; supervisors and administrators can resolve open faults.
- `users`: account profile and role. Self-registration can only create the
  technician role.
- `auditLogs`: append-only history for registrations, updates, movement,
  faults, role changes, and conflict resolution.
- `conflicts`: assignment attempts rejected because current inventory state
  did not match. Administrators can mark a reviewed conflict resolved.

Technicians can register components, record events, and report faults.
Supervisors can review audit and conflict history and resolve faults.
Administrators can also register/configure kiosks and manage user roles.
Firestore rules enforce these permissions; hiding a button in the browser is
not the security boundary.

## Offline behavior

Firestore IndexedDB persistence caches data that has already been read on the
device. Movement and fault submissions made while offline are stored in a
per-browser local queue and shown as pending. Firestore transactions cannot
run offline, so queued actions are revalidated and committed when the same
signed-in user reconnects. If inventory changed while the device was offline,
the action remains pending and the page shows the failure; it is not silently
applied or discarded. Pending actions do not sync to another user's account.

## Log component events

The **Log an Event** page looks up the component and active kiosks in Firestore.
Move, install, removal, and decommission events update the component's current
assignment and create immutable history atomically. Maintenance and faults do
not change the assignment. Fault entries are written to the fault history and
linked back to the event record. QR/barcode scanning continues to use the
browser camera on `localhost` or HTTPS, with manual component ID or
serial-number entry as a fallback. Scanned values may be either a component ID
or its registered serial number; browsers that cannot scan with their native
detector use the ZXing compatibility decoder.

On **Components**, add component IDs and serial numbers. On **Kiosks**, an
administrator can add kiosk IDs and locations. Use **Movement history** on a
component row to review its recorded events, and **View components** on a
kiosk row to inspect current assignments. The **Alerts** page calculates
warranty and expected service-life warnings in pages and includes open faults
and unresolved assignment conflicts. **Reports** can export component, kiosk,
event, and fault data as CSV files.

## Test the workflows

1. Sign in as a technician and register a component.
2. Have an administrator register an active kiosk, then install the component
   from **Log an Event**.
3. Confirm the kiosk's component list and the component's movement history
   both show the assignment.
4. Report a fault, then sign in as a supervisor or administrator and resolve
   it from **Fault History**. Confirm the audit log contains the change.
5. Export a CSV from **Reports** and verify its headers and records.
6. To test offline queuing, load inventory while online, disconnect the
   browser, submit a movement or fault, and reconnect as the same user. Check
   for the sync confirmation; if the inventory changed, check the visible
   pending-action error instead.

The scanner uses the browser camera on `localhost` or HTTPS. It uses the
built-in `BarcodeDetector` API when available and automatically loads the
ZXing barcode decoder as a fallback in browsers without it or when native
detection fails. Allow camera access and an internet connection for the fallback
to load. If camera access or decoder loading is unavailable, enter the component
ID or serial number manually; the page verifies it against the `components`
collection.
#   t r a c e p o i n t - 2  
 