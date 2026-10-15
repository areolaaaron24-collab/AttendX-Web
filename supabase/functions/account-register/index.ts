import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

function cleanText(value: unknown, max = 80): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}
function accountEmail(accountId: string): string {
  const normalized = accountId.trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const slug = normalized.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'account';
  return `ax-${slug}-${hash.toString(36)}@attendx.example.com`;
}
function validName(value: string, required = false): boolean {
  if (!value) return !required;
  return /^[\p{L}][\p{L}\p{M}\s.'’\-]*$/u.test(value) && !/\d/.test(value);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !serviceKey) return json({ error: 'Server is missing Supabase URL or service secret.' }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON request.' }, 400); }

  const role = cleanText(body.role, 20).toLowerCase();
  const teacherInviteCode = String(body.teacherInviteCode ?? '');
  const accountId = cleanText(body.accountId, 40);
  const password = String(body.password ?? '');
  const firstName = cleanText(body.firstName, 45);
  const lastName = cleanText(body.lastName, 45);
  const middleName = cleanText(body.middleName, 45);
  const suffix = cleanText(body.suffix, 15);
  const sex = cleanText(body.sex, 10);
  const course = cleanText(body.course, 30).toUpperCase();
  const yearLevel = cleanText(body.year, 10).toUpperCase();
  const section = cleanText(body.section, 10).toUpperCase();
  const department = cleanText(body.department, 60);
  const office = cleanText(body.office, 60);

  if (!['student', 'teacher'].includes(role)) return json({ error: 'Choose Student or Teacher.' }, 400);
  if (role === 'teacher') {
    const configuredInviteCode = Deno.env.get('ATTENDX_TEACHER_INVITE_CODE');
    if (!configuredInviteCode) return json({ error: 'Teacher registration is disabled until the administrator configures the private invitation code.' }, 503);
    if (!teacherInviteCode || teacherInviteCode !== configuredInviteCode) return json({ error: 'The teacher invitation code is incorrect. Ask the AttendX administrator.' }, 403);
  }
  if (!accountId) return json({ error: 'Account ID is required.' }, 400);
  if (password.length < 6) return json({ error: 'Password must contain at least 6 characters.' }, 400);
  if (!validName(firstName, true) || !validName(lastName, true) || !validName(middleName) || !validName(suffix)) {
    return json({ error: 'Please check the name fields. Use letters and normal name punctuation only.' }, 400);
  }
  if (!['Male', 'Female'].includes(sex)) return json({ error: 'Select Male or Female.' }, 400);
  if (role === 'student' && (!course || !['1ST', '2ND', '3RD', '4TH'].includes(yearLevel) || !section)) {
    return json({ error: 'Course, year level and section are required for students.' }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const normalizedId = accountId.toLowerCase();
  const { data: existing, error: lookupError } = await admin
    .from('profiles').select('id').eq('account_id_normalized', normalizedId).maybeSingle();
  if (lookupError) return json({ error: `Could not check account ID uniqueness: ${lookupError.message}` }, 500);
  if (existing) return json({ error: 'That ID is already used by a Student or Teacher account.' }, 409);

  const email = accountEmail(accountId);
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role, account_id: accountId },
  });
  if (authError || !created.user) {
    return json({ error: authError?.message ?? 'Could not create the account.' }, 400);
  }

  const profile = {
    id: created.user.id, role, account_id: accountId,
    first_name: firstName, middle_name: middleName, last_name: lastName, suffix, sex,
    course: role === 'student' ? course : null,
    year_level: role === 'student' ? yearLevel : null,
    section: role === 'student' ? section : null,
    department: role === 'teacher' ? (department || 'Information Technology') : null,
    office: role === 'teacher' ? (office || 'IT Faculty') : null,
    status: 'ACTIVE',
  };
  const { error: profileError } = await admin.from('profiles').insert(profile);
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id);
    const status = profileError.code === '23505' ? 409 : 500;
    return json({ error: profileError.code === '23505' ? 'That ID is already used by a Student or Teacher account.' : `Could not save profile: ${profileError.message}` }, status);
  }

  return json({ ok: true, accountId, message: 'Account created. Sign in with your account ID and password.' }, 201);
});
