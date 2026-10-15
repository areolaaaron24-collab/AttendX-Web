-- Keep the legacy QR-pass RPC compatible with the UUID generator used by automatic passes.
-- Enrollments receive QR tokens from migration 202610150002; this RPC remains safe for existing callers.

create or replace function public.get_or_create_student_qr_token(p_schedule_id text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_token text;
begin
  if auth.uid() is null or public.attendx_current_role() <> 'student' then
    raise exception 'Only a student account can get a class QR pass.';
  end if;
  if not exists (select 1 from public.enrollments where student_id = auth.uid() and schedule_id = p_schedule_id) then
    raise exception 'Join this class before creating a QR pass.';
  end if;
  insert into public.qr_tokens as existing_qr(student_id, schedule_id, token)
  values (auth.uid(), p_schedule_id, 'ATTENDX-' || replace(gen_random_uuid()::text, '-', ''))
  on conflict (student_id, schedule_id) do update
    set token = existing_qr.token
  returning token into v_token;
  return v_token;
end;
$$;
revoke all on function public.get_or_create_student_qr_token(text) from public, anon;
grant execute on function public.get_or_create_student_qr_token(text) to authenticated;
