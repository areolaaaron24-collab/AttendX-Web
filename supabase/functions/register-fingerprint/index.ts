import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

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
    return json({ error: 'Only active teacher accounts can enroll fingerprint templates.' }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid fingerprint enrollment data.' }, 400); }
  const scheduleId = String(body.scheduleId ?? '').trim();
  const studentId = String(body.studentId ?? '').trim();
  const deviceId = String(body.deviceId ?? '').trim();
  const sensorSlot = Number(body.sensorSlot);
  if (!scheduleId || !studentId || !/^[a-zA-Z0-9._:-]{1,64}$/.test(deviceId) || !Number.isInteger(sensorSlot) || sensorSlot < 1 || sensorSlot > 255) {
    return json({ error: 'The schedule, student, device ID, or sensor slot is invalid.' }, 400);
  }

  const { data: schedule, error: scheduleError } = await admin.from('schedules')
    .select('id,teacher_id,status').eq('id', scheduleId).eq('teacher_id', user.id).eq('status', 'ACTIVE').maybeSingle();
  if (scheduleError || !schedule) return json({ error: 'Choose an active class schedule owned by your account.' }, 403);

  const { data: student, error: studentError } = await admin.from('profiles')
    .select('id,role,status,first_name,last_name').eq('id', studentId).maybeSingle();
  if (studentError || student?.role !== 'student' || student.status !== 'ACTIVE') {
    return json({ error: 'The selected student account is missing or inactive.' }, 404);
  }
  const { data: enrollment, error: enrollmentError } = await admin.from('enrollments')
    .select('student_id').eq('student_id', studentId).eq('schedule_id', scheduleId).maybeSingle();
  if (enrollmentError || !enrollment) return json({ error: 'The selected student is not enrolled in this class.' }, 403);

  const { data: slotOwner, error: slotError } = await admin.from('fingerprint_templates')
    .select('student_id').eq('device_id', deviceId).eq('sensor_slot', sensorSlot).maybeSingle();
  if (slotError) return json({ error: 'Could not check fingerprint slot ownership.' }, 500);
  if (slotOwner && slotOwner.student_id !== studentId) {
    return json({ error: 'That reader slot is already assigned to another student. Refresh the roster and try again.' }, 409);
  }
  const { data: previous, error: previousError } = await admin.from('fingerprint_templates')
    .select('sensor_slot').eq('device_id', deviceId).eq('student_id', studentId).maybeSingle();
  if (previousError) return json({ error: 'Could not check the student’s existing fingerprint registration.' }, 500);
  if (previous && Number(previous.sensor_slot) !== sensorSlot) {
    return json({ error: 'This student already has another reader slot. Refresh the roster and enroll again using the existing slot.' }, 409);
  }

  const { error: saveError } = await admin.from('fingerprint_templates').upsert({
    device_id: deviceId, sensor_slot: sensorSlot, student_id: studentId,
    registered_by: user.id, updated_at: new Date().toISOString(),
  }, { onConflict: 'device_id,student_id' });
  if (saveError) return json({ error: `Could not save fingerprint mapping: ${saveError.message}` }, 500);

  await admin.from('audit_logs').insert({
    actor_id: user.id, actor_role: 'teacher', action: 'FINGERPRINT_TEMPLATE_REGISTERED',
    details: { schedule_id: scheduleId, student_id: studentId, device_id: deviceId, sensor_slot: sensorSlot },
  });
  return json({ ok: true, sensorSlot, student: { id: student.id, name: [student.first_name, student.last_name].filter(Boolean).join(' ') } });
});
