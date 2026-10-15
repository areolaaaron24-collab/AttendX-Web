# AttendX Web — legacy-flow port

AttendX Web is a responsive browser-based port of the uploaded AttendX Python/CustomTkinter app. The user flow is **Welcome intro → Student or Teacher portal → login/register → role dashboard → class/schedule → QR or face verification → attendance records**. The shared data store is Supabase Postgres, and the frontend is built with HTML, CSS, JavaScript and Vite.

> **Compatibility note:** a Python desktop application cannot be byte-for-byte or pixel-for-pixel identical after it is ported to a browser. This project ports the visible flow and relevant rules based on the uploaded files; it must be tested against your target desktop build before calling it a complete 1:1 replacement. The uploaded ZIP did not include the original logo/asset directory, so the intro currently uses a matching AttendX-inspired vector mark. The browser face model also differs from the Python/dlib-based matching stack; it performs live descriptor matching, but its accuracy must be validated separately.

## Features implemented

- Responsive intro animation, role selection, Student and Teacher sign-in/registration.
- Account ID login backed by Supabase Auth; IDs are checked for uniqueness across both roles.
- Student profile and face-template registration, class discovery filtered by course/year/section, enrollment, automatic per-student/per-class QR pass creation on enrollment, and attendance history.
- Teacher subject catalog, inline Add Schedule page, My Schedule, student roster/removal, attendance center, persistent live QR and face scans, no-show marking after class end, records search and CSV export.
- Server-authoritative attendance writes through guarded Postgres RPC functions; one attendance record per student/class/Manila date.
- Row Level Security policies, audit/login history, automatic DROPPED status after the absence threshold, and a persistent per-student/per-class QR token automatically created by a database trigger whenever a student enrolls. Existing enrollments are backfilled by the second migration.
- Mobile browser camera access over HTTPS; on local desktop use `http://localhost:5173`.
- GitHub Actions workflow to build and publish the static frontend on GitHub Pages.

## Hardware and web-platform limits

- **QR:** real QR images are generated and scanned by the browser camera. On phones, use the deployed HTTPS link and accept camera permission.
- **Face:** students can register a face descriptor from a live camera; a server-side function checks the template against existing accounts before save, then the teacher's live camera compares a scan to templates for students enrolled in that class. Models load from the configured CDN. Good light and a modern browser are required. Face recognition is probabilistic, not a perfect identity guarantee; similar-looking people can be rejected, ambiguous matches are rejected, and QR should be used as fallback. Biometrics require informed consent. Never use face matching as the only security factor for high-stakes decisions.
- **Fingerprint:** the web version supports a real AS608/R307-compatible reader through Chrome/Edge Web Serial on a compatible HTTPS computer with the reader connected by USB-to-serial. The teacher must use the same computer/browser profile and reader for enrollment and scanning, select the reader, enroll the student by scanning the same finger twice, and then use Fingerprint Scan. The browser creates a private local reader ID so two unrelated computers do not silently share sensor-slot mappings. The sensor stores the fingerprint template internally; Supabase stores only the device ID, sensor slot, student mapping and audit record. Most phone browsers cannot directly access a UART fingerprint module, so mobile use requires a separate supported hardware bridge/native app. This implementation must be tested against the exact sensor board, USB-to-serial adapter and baud rate before real deployment.
- **Deployment:** GitHub Pages hosts static files only; Supabase supplies authentication, SQL data, Row Level Security and Edge Functions. The website requires the Supabase project to be configured first.

## Requirements

- Node.js 20+ (Node.js 22 is recommended).
- VS Code (or another editor).
- A Supabase project with the ability to apply SQL and deploy Edge Functions.
- Git/GitHub for publishing.

## Run locally in VS Code

1. Extract this project to a folder and open that folder in VS Code.
2. In VS Code, open **Terminal → New Terminal**.
3. Install dependencies:

   ```powershell
   npm install
   ```

4. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

5. Open `.env` and enter your Supabase **Project URL** and **public anon/publishable key**. Do not put a service-role or secret key in this file.
6. Complete the SQL/Edge Function setup in the next section.
7. Start the development server:

   ```powershell
   npm run dev
   ```

8. Open the local URL shown in the terminal (normally `http://localhost:5173`). To stop, press `Ctrl+C` in the terminal.

If PowerShell cannot find `npm`, install Node.js LTS and restart VS Code. This project does not require a VS Code extension to run.

## Set up the Supabase SQL database

1. Use a **new Supabase project dedicated to this web port**, or verify that the public schema is clean and take a backup first. Do not run this migration blindly over the earlier Flet/Supabase schema: `CREATE TABLE IF NOT EXISTS` will not reshape existing tables whose columns differ.
2. Open **SQL Editor → New query** in the Supabase dashboard.
3. Prefer the CLI migration flow from the project root: `npx.cmd supabase link --project-ref ligzoiktrdwcdqpkaudr` followed by `npx.cmd supabase db push`. The migration directory includes `202610150001_attendx_web.sql` for the base schema and `202610150002_auto_qr_per_enrollment.sql` to create QR tokens for new and existing enrollments. If you use SQL Editor manually, apply both migration files in numeric order and remember that manual SQL Editor execution does not update the CLI migration history.
4. Confirm all four migrations complete, then confirm the tables exist: `profiles`, `subjects`, `schedules`, `enrollments`, `attendance`, `qr_tokens`, `face_templates`, `attendance_sessions`, `login_history`, and `audit_logs`. The `attendance_sessions` helper is retained for compatibility with the older QR helper; the active `main2.py` scanner flow does not require an active session row.
5. Confirm that Row Level Security is enabled. The migration creates the policies and server RPCs expected by the frontend.
6. In `.env`, set:

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
   VITE_FACE_MODEL_URL=https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model
   ```

The web app's Supabase public key is designed to be visible to browsers, but access must still be restricted by the supplied RLS policies. Never disable RLS to “fix” an error.

## Deploy the Supabase Edge Functions

The project uses four Edge Functions:

- `account-register`: safely creates a Supabase Auth user and their profile. Student registration is open; **teacher registration requires the private server-side invitation code** so a public GitHub link cannot let anyone create a teacher account.
- `verify-qr`: validates a student's persistent QR token against the selected active class, the teacher who owns it, and current enrollment.
- `register-face`: checks the new face descriptor against existing accounts before storing it, preventing a face from being enrolled on multiple accounts based on the configured similarity threshold.
- `verify-face`: checks a live 128-number descriptor against registered templates for students enrolled in that class.

With the Supabase CLI installed and authenticated, run these commands in the project folder:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set ATTENDX_TEACHER_INVITE_CODE="REPLACE_WITH_A_LONG_RANDOM_PRIVATE_CODE"
supabase functions deploy account-register --no-verify-jwt
supabase functions deploy register-face
supabase functions deploy verify-qr
supabase functions deploy verify-face
```

Supabase normally injects its legacy `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` variables into hosted Edge Functions. If your project uses only the newer API key format, configure a server-side `SUPABASE_PUBLISHABLE_KEY` function secret for the verification functions, for example `supabase secrets set SUPABASE_PUBLISHABLE_KEY="sb_publishable_REPLACE_WITH_YOUR_PUBLIC_KEY"`. Any secret/service key must remain in the Supabase function environment; **never copy a secret/service key to `.env`, frontend code, GitHub repository files, or GitHub Pages secrets**. The `ATTENDX_TEACHER_INVITE_CODE` must be replaced with your own long random code and shared privately only with authorized teachers; never put it in frontend code, `.env`, or GitHub. If using only the new publishable-key format on the Supabase project, you may also need to configure the `SUPABASE_PUBLISHABLE_KEY` Edge Function secret so authenticated requests can be verified. The Edge Functions use the server-side service key to create accounts and read biometric templates; this key bypasses RLS.

## Publish on GitHub Pages

1. Create a **private** or **public** GitHub repository for the code. Do not commit an actual `.env` file or export/backup of student data.
2. Push this project to the repository's `main` branch.
3. In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `VITE_SUPABASE_URL` — the Supabase project URL.
   - `VITE_SUPABASE_ANON_KEY` — the public anon key.
   - Or use `VITE_SUPABASE_PUBLISHABLE_KEY` instead of the previous one.
4. Go to **Settings → Pages** and choose **GitHub Actions** as the build/deploy source.
5. The workflow `.github/workflows/deploy.yml` automatically installs packages, syntax-checks the JS, runs static policy guard tests, builds the site, and deploys it on pushes to `main`. GitHub Pages then shows the public URL under Settings → Pages.
6. Open the URL on a phone and allow camera access. The HTTPS GitHub Pages URL is required for phone camera access.

The web bundle contains only the public key. Never pass the Supabase service-role/secret key to a `VITE_*` variable or to the frontend build, because `VITE_*` values are bundled into browser assets. Server-only keys belong only in the Supabase Edge Function environment.

## Suggested acceptance test checklist

- [ ] Intro animation finishes and shows Student/Teacher role selection.
- [ ] A student can register and log in through School ID, then edit the profile.
- [ ] A teacher can register and log in through Teacher ID only after the administrator configures a private invitation code and the teacher enters it.
- [ ] Duplicate Account ID is blocked even if the role is different.
- [ ] Teacher can add subject and create a schedule with end time after start time.
- [ ] Student can only find and join a schedule matching Course, Year and Section.
- [ ] Student joins a matching class and receives a QR pass automatically for that student/class; no Generate QR button is needed. Existing enrollments receive tokens from migration 002.
- [ ] Teacher can select one of their own active schedules, and a QR scan records once without closing the camera.
- [ ] Duplicate scan produces ALREADY VERIFIED, not a duplicate row. A permanent QR token is retained per student/class to match the active desktop scanner.
- [ ] Face enrollment checks for a duplicate match before save; face scan works in good lighting when CDN models load, and unregistered/ambiguous matches are rejected.
- [ ] Before/exactly-at-start status matches the active desktop status function; after start through 14:59 is LATE; at 15:00+ is LATE-ABSENT.
- [ ] No-shows can be marked only after the scheduled class end; repeated no-show marking does not create duplicate attendance rows, and a later valid scan can correct a system-created ABSENT row.
- [ ] Three ABSENT/LATE-ABSENT outcomes trigger the status threshold, and teacher record/CSV reflects the persisted rows.
- [ ] A student cannot directly write attendance rows or view another student's private profile/face descriptor.
- [ ] Mobile navigation is usable in portrait layout, and cameras stop when leaving Attendance Center.

## Data safety

Use a test Supabase project and test accounts first. The old `attendance.db` with real legacy accounts and attendance history was intentionally not copied into this web project. The QR token follows the active desktop path and remains stable for a student/class pair; keep QR passes private and use the server's class/enrollment checks. Face descriptors are biometric data even though raw images are not stored here; use consent, limit access and deletion, and verify local privacy requirements before enrolling real students.

## Source folders

```text
index.html
src/app.js
src/styles.css
public/attendx-mark.svg
supabase/migrations/202610150001_attendx_web.sql
supabase/migrations/202610150002_auto_qr_per_enrollment.sql
supabase/functions/account-register/index.ts
supabase/functions/register-face/index.ts
supabase/functions/verify-qr/index.ts
supabase/functions/verify-face/index.ts
.github/workflows/deploy.yml
tests/attendance-policy.test.js
.env.example
```
