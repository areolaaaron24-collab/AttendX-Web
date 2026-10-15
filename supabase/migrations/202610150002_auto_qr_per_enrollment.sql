-- Automatically create one persistent QR token for each enrolled student and class.
-- Token rows remain private to their student via qr_tokens RLS.
-- This migration also backfills existing enrollments so students do not need to press "Generate QR".

create or replace function public.attendx_auto_create_enrollment_qr()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.qr_tokens (student_id, schedule_id, token)
  values (
    new.student_id,
    new.schedule_id,
    'ATTENDX-' || replace(gen_random_uuid()::text, '-', '')
  )
  on conflict (student_id, schedule_id) do nothing;

  return new;
end;
$$;

revoke all on function public.attendx_auto_create_enrollment_qr() from public, anon, authenticated;

drop trigger if exists enrollments_auto_create_qr on public.enrollments;
create trigger enrollments_auto_create_qr
after insert on public.enrollments
for each row
execute function public.attendx_auto_create_enrollment_qr();

-- Generate QR tokens for all existing student/class enrollments, preserving any token already created.
insert into public.qr_tokens (student_id, schedule_id, token)
select
  e.student_id,
  e.schedule_id,
  'ATTENDX-' || replace(gen_random_uuid()::text, '-', '')
from public.enrollments e
on conflict (student_id, schedule_id) do nothing;

