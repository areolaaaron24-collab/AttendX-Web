-- Store only the device slot-to-student mapping. Fingerprint images/templates stay inside the AS608/R307 sensor.
create table if not exists public.fingerprint_templates (
  id uuid primary key default gen_random_uuid(),
  device_id text not null check (char_length(device_id) between 1 and 64),
  sensor_slot integer not null check (sensor_slot between 1 and 255),
  student_id uuid not null references public.profiles(id) on delete cascade,
  registered_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (device_id, sensor_slot),
  unique (device_id, student_id)
);

alter table public.fingerprint_templates enable row level security;
drop policy if exists fingerprint_templates_read_teacher_roster on public.fingerprint_templates;
create policy fingerprint_templates_read_teacher_roster
on public.fingerprint_templates
for select to authenticated
using (
  public.attendx_current_role() = 'teacher'
  and exists (
    select 1
    from public.enrollments e
    join public.schedules s on s.id = e.schedule_id
    where e.student_id = fingerprint_templates.student_id
      and s.teacher_id = auth.uid()
  )
);

grant select on public.fingerprint_templates to authenticated;
revoke insert, update, delete on public.fingerprint_templates from anon, authenticated;
