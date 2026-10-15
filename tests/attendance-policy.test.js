import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(resolve(root, 'supabase/migrations/202610150001_attendx_web.sql'), 'utf8');
const autoQrSql = readFileSync(resolve(root, 'supabase/migrations/202610150002_auto_qr_per_enrollment.sql'), 'utf8');
const accountRegisterFunction = readFileSync(resolve(root, 'supabase/functions/account-register/index.ts'), 'utf8');
const qrFunction = readFileSync(resolve(root, 'supabase/functions/verify-qr/index.ts'), 'utf8');
const faceRegisterFunction = readFileSync(resolve(root, 'supabase/functions/register-face/index.ts'), 'utf8');
const faceFunction = readFileSync(resolve(root, 'supabase/functions/verify-face/index.ts'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const app = readFileSync(resolve(root, 'src/app.js'), 'utf8');

test('SQL attendance status boundaries match the selected AttendX rule', () => {
  assert.match(sql, /if v_elapsed <= interval '0 seconds' then v_status := 'PRESENT';\s*elsif v_elapsed < interval '15 minutes' then v_status := 'LATE';\s*else v_status := 'LATE-ABSENT';/i);
});

test('database prevents duplicate attendance for a student, class and date', () => {
  assert.match(sql, /unique\s*\(student_id,\s*schedule_id,\s*attendance_date\)/i);
  assert.match(sql, /revoke insert, update, delete on public\.attendance from anon, authenticated/i);
});

test('student QR tokens remain stable for one student/class pair', () => {
  assert.match(sql, /unique\s*\(student_id,\s*schedule_id\)/i);
  assert.match(sql, /'ATTENDX-'\s*\|\|\s*encode\(gen_random_bytes\(16\), 'hex'\)/i);
  assert.match(sql, /on conflict \(student_id, schedule_id\) do update\s+set token = existing_qr\.token/i);
});

test('QR and face verification require an authenticated teacher who owns an active class', () => {
  assert.match(qrFunction, /profile\?\.role !== 'teacher'/);
  assert.match(qrFunction, /eq\('teacher_id', user\.id\)\.eq\('status', 'ACTIVE'\)/);
  assert.match(faceFunction, /profile\?\.role !== 'teacher'/);
  assert.match(faceFunction, /eq\('teacher_id', user\.id\)\.eq\('status', 'ACTIVE'\)/);
});

test('frontend environment template does not assign a secret/service-role key', () => {
  assert.doesNotMatch(envExample, /^\s*(?:VITE_)?SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY)\s*=/im);
});

test('face registration checks other accounts before saving the descriptor', () => {
  assert.match(faceRegisterFunction, /MATCH_THRESHOLD = 0\.46/);
  assert.match(faceRegisterFunction, /item\.student_id === user\.id/);
  assert.match(faceRegisterFunction, /closestOtherDistance <= MATCH_THRESHOLD/);
  assert.match(sql, /revoke insert, update, delete on public\.face_templates from anon, authenticated/i);
});


test('public account registration cannot create teacher accounts without a private server-side invite code', () => {
  assert.match(accountRegisterFunction, /Deno\.env\.get\('ATTENDX_TEACHER_INVITE_CODE'\)/);
  assert.match(accountRegisterFunction, /teacherInviteCode !== configuredInviteCode/);
  assert.match(accountRegisterFunction, /Teacher registration is disabled until the administrator configures/);
});


test('every enrollment automatically creates one persistent student/class QR token', () => {
  assert.match(autoQrSql, /create trigger enrollments_auto_create_qr\s+after insert on public\.enrollments\s+for each row\s+execute function public\.attendx_auto_create_enrollment_qr\(\)/i);
  assert.match(autoQrSql, /new\.student_id[\s\S]*new\.schedule_id[\s\S]*ATTENDX-/i);
  assert.match(autoQrSql, /select\s+e\.student_id,\s*e\.schedule_id[\s\S]*from public\.enrollments e[\s\S]*on conflict \(student_id, schedule_id\) do nothing/i);
});

test('student QR page displays automatic passes and has no Generate QR button', () => {
  assert.match(app, /Your QR pass is created automatically for every class you join/);
  assert.match(app, /data-action="refresh-qr-passes"/);
  assert.doesNotMatch(app, /data-action="generate-qr"/);
  assert.doesNotMatch(app, /case 'generate-qr'/);
});

test('face attendance is independent of QR token generation', () => {
  assert.match(app, /You do not need to generate a QR pass for face attendance/);
  assert.match(app, /functions\.invoke\('verify-face'/);
  assert.match(app, /saveAttendanceViaRpc\(candidateStudentId, scheduleId, 'FACE'\)/);
});

test('fingerprint attendance is not reported successful without hardware integration', () => {
  assert.match(app, /Fingerprint reader not connected/);
  assert.match(app, /must not mark a student present until the reader actually verifies a fingerprint/);
});

test('Add Schedule accepts a manually typed subject and adds missing names to the catalog', () => {
  assert.match(app, /<input name="subject" required maxlength="80" placeholder="Type the subject name/);
  assert.match(app, /from\('subjects'\)\.insert\(\{ name:subject, created_by:currentUserId \}\)/);
  assert.match(app, /from\('schedules'\)\.insert\(schedule\)/);
});
