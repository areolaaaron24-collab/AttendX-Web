import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
});
const MATCH_THRESHOLD = 0.46;
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
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const authorization = req.headers.get('Authorization');
  if (!url || !serviceKey || !anonKey || !authorization) return json({ error: 'Missing server setup or authenticated session.' }, 401);

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userError } = await callerClient.auth.getUser();
  if (userError || !user) return json({ error: 'Please log in again.' }, 401);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: profile, error: profileError } = await admin.from('profiles').select('role,status').eq('id', user.id).maybeSingle();
  if (profileError || profile?.role !== 'student' || profile.status !== 'ACTIVE') {
    return json({ error: 'Only active student accounts can register face recognition.' }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Invalid face data.' }, 400); }
  const raw = body.descriptor;
  if (!Array.isArray(raw) || raw.length !== 128 || raw.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    return json({ error: 'The face descriptor is invalid.' }, 400);
  }
  const descriptor = raw as number[];
  const { data: templates, error: templatesError } = await admin.from('face_templates').select('student_id,descriptor');
  if (templatesError) return json({ error: `Could not verify whether this face is already registered: ${templatesError.message}` }, 500);

  let closestOtherDistance = Number.POSITIVE_INFINITY;
  for (const item of templates ?? []) {
    if (item.student_id === user.id || !Array.isArray(item.descriptor) || item.descriptor.length !== 128) continue;
    const candidate = distance(descriptor, item.descriptor.map(Number));
    if (candidate < closestOtherDistance) closestOtherDistance = candidate;
  }
  if (closestOtherDistance <= MATCH_THRESHOLD) {
    return json({ error: 'This face is too similar to a face already registered to another account. Use the QR method or contact the teacher to resolve the identity match.' }, 409);
  }

  const { error: saveError } = await admin.from('face_templates').upsert({
    student_id: user.id,
    descriptor,
    model_version: 'face-api-128d-v1',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'student_id' });
  if (saveError) return json({ error: `Could not save face data: ${saveError.message}` }, 500);
  await admin.from('audit_logs').insert({ actor_id: user.id, actor_role: 'student', action: 'FACE_TEMPLATE_REGISTERED', details: { model_version: 'face-api-128d-v1' } });
  return json({ ok: true, message: 'Face template saved. This face was not matched to another registered account.' });
});
