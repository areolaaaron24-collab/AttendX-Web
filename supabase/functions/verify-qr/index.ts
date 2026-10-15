import { createClient } from 'npm:@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const authorization = req.headers.get('Authorization');
  if (!url || !serviceKey || !anonKey || !authorization) return json({ error: 'Missing server setup or authenticated session.' }, 401);
  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) return json({ error: 'Please log in again.' }, 401);
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: profile } = await admin.from('profiles').select('role,status').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'teacher' || profile.status !== 'ACTIVE') return json({ error: 'Only active teacher accounts can scan student QR passes.' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid scan data.' }, 400); }
  const token = String(body.token ?? '').trim();
  const scheduleId = String(body.scheduleId ?? '').trim();
  if (!token || !scheduleId || token.length > 160) return json({ error: 'QR content is missing or invalid.' }, 400);

  const { data: schedule, error: scheduleError } = await admin.from('schedules').select('id,teacher_id,status')
    .eq('id', scheduleId).eq('teacher_id', user.id).eq('status', 'ACTIVE').maybeSingle();
  if (scheduleError || !schedule) return json({ error: 'You can only scan QR passes for your own active class schedule.' }, 403);

  const { data: qr, error: qrError } = await admin.from('qr_tokens').select('student_id,schedule_id')
    .eq('token', token).eq('schedule_id', scheduleId).maybeSingle();
  if (qrError || !qr) return json({ error: 'This QR pass is not valid for the selected class.' }, 404);
  const { data: enrollment } = await admin.from('enrollments').select('id')
    .eq('student_id', qr.student_id).eq('schedule_id', scheduleId).maybeSingle();
  if (!enrollment) return json({ error: 'The student is no longer enrolled in this class.' }, 403);
  const { data: student } = await admin.from('profiles').select('id,account_id,first_name,middle_name,last_name,suffix,status')
    .eq('id', qr.student_id).maybeSingle();
  if (!student || student.status === 'INACTIVE') return json({ error: 'Student account is inactive.' }, 403);
  return json({ ok: true, student: { id: student.id, accountId: student.account_id,
    name: [student.first_name, student.middle_name, student.last_name, student.suffix].filter(Boolean).join(' ') } });
});
