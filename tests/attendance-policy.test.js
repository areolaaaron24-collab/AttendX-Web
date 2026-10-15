import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(resolve(root, 'supabase/migrations/202610150001_attendx_web.sql'), 'utf8');
const accountRegisterFunction = readFileSync(resolve(root, 'supabase/functions/account-register/index.ts'), 'utf8');
const qrFunction = readFileSync(resolve(root, 'supabase/functions/verify-qr/index.ts'), 'utf8');
const faceRegisterFunction = readFileSync(resolve(root, 'supabase/functions/register-face/index.ts'), 'utf8');
const faceFunction = readFileSync(resolve(root, 'supabase/functions/verify-face/index.ts'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');

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
