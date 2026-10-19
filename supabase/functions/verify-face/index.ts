import { createClient } from 'npm:@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
function distance(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

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
  if (profile?.role !== 'teacher' || profile.status !== 'ACTIVE') return json({ error: 'Only active teacher accounts can use face attendance.' }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid face data.' }, 400); }
  const scheduleId = String(body.scheduleId ?? '').trim();
  const descriptor = body.descriptor;
  if (!scheduleId || !Array.isArray(descriptor) || descriptor.length !== 128 || descriptor.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    return json({ error: 'The face descriptor is invalid.' }, 400);
  }
  const { data: schedule } = await admin.from('schedules').select('id,teacher_id,status').eq('id', scheduleId).eq('teacher_id', user.id).eq('status', 'ACTIVE').maybeSingle();
  if (!schedule) return json({ error: 'You can only scan an active class schedule you own.' }, 403);
  const { data: enrollments, error: enrollmentError } = await admin.from('enrollments').select('student_id').eq('schedule_id', scheduleId);
  if (enrollmentError || !enrollments?.length) return json({ error: 'No students are enrolled in this class.' }, 404);
  const ids = enrollments.map((row) => row.student_id);
  const { data: templates, error: templateError } = await admin.from('face_templates').select('student_id,descriptor').in('student_id', ids).eq('model_version', 'face-api-128d-v1');
  if (templateError || !templates?.length) return json({ error: 'No enrolled students have registered face data yet.' }, 404);

  const sample = (descriptor as number[]).map(Number);
  const scored = templates.filter((item) => Array.isArray(item.descriptor) && item.descriptor.length === 128)
    .map((item) => ({ id: item.student_id, distance: distance(sample, item.descriptor.map(Number)) }))
    .sort((a, b) => a.distance - b.distance);
  if (!scored.length || scored[0].distance > 0.46) return json({ error: 'No confident face match. Try again with better lighting or use QR verification.' }, 404);
  if (scored.length > 1 && scored[1].distance - scored[0].distance < 0.025) {
    return json({ error: 'The face match is ambiguous. Use QR verification to avoid confusing similar faces.' }, 409);
  }
  const { data: student } = await admin.from('profiles').select('id,account_id,first_name,middle_name,last_name,suffix,status')
    .eq('id', scored[0].id).maybeSingle();
  if (!student || student.status === 'INACTIVE') return json({ error: 'Matched student account is inactive.' }, 403);
  return json({ ok: true, distance: Number(scored[0].distance.toFixed(4)), student: { id: student.id, accountId: student.account_id,
    name: [student.first_name, student.middle_name, student.last_name, student.suffix].filter(Boolean).join(' ') } });
});
