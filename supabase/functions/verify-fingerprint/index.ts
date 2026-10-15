import { createClient } from 'npm:@supabase/supabase-js@2.117.3.117.3';

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
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const authorization = req.headers.get('Authorization');
  if (!url || !serviceKey || !publicKey || !authorization) return json({ error: 'Missing server setup or authenticated session.' }, 401);

  const caller = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: { user }, error: authError } = await caller.auth.getUser();
  if (authError || !user) return json({ error: 'Please log in again.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: teacher, error: teacherError } = await admin.from('profiles').select('role,status').eq('id', user.id).maybeSingle();
  if (teacherError || teacher?.role !== 'teacher' || teacher.status !== 'ACTIVE') {
    return json({ error: 'Only active teacher accounts can verify fingerprints.' }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid fingerprint scan data.' }, 400); }
  const scheduleId = String(body.scheduleId ?? '').trim();
  const deviceId = String(body.deviceId ?? '').trim();
  const sensorSlot = Number(body.sensorSlot);
  if (!scheduleId || !/^[a-zA-Z0-9._:-]{1,64}$/.test(deviceId) || !Number.isInteger(sensorSlot) || sensorSlot < 1 || sensorSlot > 255) {
    return json({ error: 'The schedule, device ID, or sensor slot is invalid.' }, 400);
  }

  const { data: schedule, error: scheduleError } = await admin.from('schedules')
    .select('id,teacher_id,status').eq('id', scheduleId).eq('teacher_id', user.id).eq('status', 'ACTIVE').maybeSingle();
  if (scheduleError || !schedule) return json({ error: 'You can only scan fingerprints for an active class schedule you own.' }, 403);

  const { data: template, error: templateError } = await admin.from('fingerprint_templates')
    .select('student_id').eq('device_id', deviceId).eq('sensor_slot', sensorSlot).maybeSingle();
  if (templateError) return json({ error: 'Could not look up the verified fingerprint mapping.' }, 500);
  if (!template) return json({ error: 'This fingerprint slot is not registered in AttendX. Ask the teacher to enroll the student first.' }, 404);

  const { data: enrollment, error: enrollmentError } = await admin.from('enrollments')
    .select('student_id').eq('student_id', template.student_id).eq('schedule_id', scheduleId).maybeSingle();
  if (enrollmentError || !enrollment) return json({ error: 'This fingerprint belongs to a student who is not enrolled in the selected class.' }, 403);

  const { data: student, error: studentError } = await admin.from('profiles')
    .select('id,account_id,first_name,middle_name,last_name,suffix,status').eq('id', template.student_id).maybeSingle();
  if (studentError || student?.status !== 'ACTIVE') return json({ error: 'The matched student account is inactive.' }, 403);
  return json({ ok: true, student: {
    id: student.id, accountId: student.account_id,
    name: [student.first_name, student.middle_name, student.last_name, student.suffix].filter(Boolean).join(' '),
  } });
});
