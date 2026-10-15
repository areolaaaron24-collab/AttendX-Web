-- AttendX Web: cloud schema for the legacy Student/Teacher flow.
-- Run in Supabase SQL Editor or `supabase db push`. The browser NEVER gets service-role access.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('student','teacher')),
  account_id text not null,
  account_id_normalized text generated always as (lower(btrim(account_id))) stored,
  first_name text not null,
  middle_name text not null default '',
  last_name text not null,
  suffix text not null default '',
  sex text not null check (sex in ('Male','Female')),
  course text,
  year_level text,
  section text,
  department text,
  office text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE','DROPPED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_account_id_normalized_unique unique (account_id_normalized),
  constraint profiles_student_fields check (
    (role = 'student' and coalesce(trim(course),'') <> '' and coalesce(trim(year_level),'') <> '' and coalesce(trim(section),'') <> '')
    or role = 'teacher'
  )
);

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (name_key)
);

create table if not exists public.schedules (
  id text primary key,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  course text not null,
  subject text not null,
  section text not null,
  year_level text not null,
  day text not null check (day in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  start_time time without time zone not null,
  end_time time without time zone not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_time_order check (end_time > start_time)
);
create index if not exists schedules_teacher_idx on public.schedules(teacher_id);
create index if not exists schedules_course_section_idx on public.schedules(course, year_level, section);

create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  schedule_id text not null references public.schedules(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (student_id, schedule_id)
);
create index if not exists enrollments_schedule_idx on public.enrollments(schedule_id);

create table if not exists public.attendance (
  id text primary key default gen_random_uuid()::text,
  student_id uuid not null references public.profiles(id) on delete cascade,
  schedule_id text not null references public.schedules(id) on delete cascade,
  attendance_date date not null,
  attendance_time time without time zone not null,
  status text not null check (status in ('PRESENT','LATE','LATE-ABSENT','ABSENT')),
  method text not null check (method in ('QR','FACE','FINGERPRINT','SYSTEM')),
  created_at timestamptz not null default now(),
  unique (student_id, schedule_id, attendance_date)
);
create index if not exists attendance_schedule_date_idx on public.attendance(schedule_id, attendance_date);
create index if not exists attendance_student_date_idx on public.attendance(student_id, attendance_date desc);

create table if not exists public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  schedule_id text not null references public.schedules(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  unique (student_id, schedule_id)
);

create table if not exists public.face_templates (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  descriptor double precision[] not null,
  model_version text not null default 'face-api-128d-v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint face_descriptor_length check (cardinality(descriptor) = 128)
);

create table if not exists public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  schedule_id text not null references public.schedules(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  session_token uuid not null default gen_random_uuid() unique,
  session_date date not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED','EXPIRED')),
  unique (schedule_id, session_date)
);

create table if not exists public.login_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('student','teacher')),
  account_id text not null,
  logged_in_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  actor_role text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.attendx_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.attendx_set_updated_at();
drop trigger if exists schedules_set_updated_at on public.schedules;
create trigger schedules_set_updated_at before update on public.schedules
for each row execute function public.attendx_set_updated_at();
drop trigger if exists face_templates_set_updated_at on public.face_templates;
create trigger face_templates_set_updated_at before update on public.face_templates
for each row execute function public.attendx_set_updated_at();

-- Prevent users from changing their account ID, role or status through profile editing.
create or replace function public.attendx_protect_profile_identity()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and auth.uid() = old.id then
    if new.role is distinct from old.role
       or new.account_id is distinct from old.account_id
       or new.status is distinct from old.status then
      raise exception 'Role, account ID and account status cannot be edited from the profile page.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_identity on public.profiles;
create trigger protect_profile_identity before update on public.profiles
for each row execute function public.attendx_protect_profile_identity();

create or replace function public.attendx_current_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() limit 1;
$$;

create or replace function public.attendx_can_view_profile(target_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_role text;
begin
  if auth.uid() is null then return false; end if;
  if target_id = auth.uid() then return true; end if;
  v_role := public.attendx_current_role();
  if v_role = 'teacher' then
    return exists (
      select 1 from public.profiles p
      join public.enrollments e on e.student_id = p.id
      join public.schedules s on s.id = e.schedule_id
      where p.id = target_id and p.role = 'student' and s.teacher_id = auth.uid()
    ) or exists (
      -- Preserve student names for the teacher's historical attendance after roster removal.
      select 1 from public.profiles p
      join public.attendance a on a.student_id = p.id
      join public.schedules s on s.id = a.schedule_id
      where p.id = target_id and p.role = 'student' and s.teacher_id = auth.uid()
    );
  elsif v_role = 'student' then
    return exists (
      select 1 from public.profiles p
      join public.schedules s on s.teacher_id = p.id
      join public.enrollments e on e.schedule_id = s.id
      where p.id = target_id and p.role = 'teacher' and e.student_id = auth.uid()
    );
  end if;
  return false;
end;
$$;
revoke all on function public.attendx_current_role() from public, anon;
revoke all on function public.attendx_can_view_profile(uuid) from public, anon;
grant execute on function public.attendx_current_role() to authenticated;
grant execute on function public.attendx_can_view_profile(uuid) to authenticated;

-- A restricted directory view exposes only teacher names/departments needed to identify class owners.
create or replace view public.attendx_teacher_directory with (security_invoker = false) as
select id, role, first_name, middle_name, last_name, suffix, department, status
from public.profiles where role = 'teacher' and status = 'ACTIVE';
grant select on public.attendx_teacher_directory to authenticated;

alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.schedules enable row level security;
alter table public.enrollments enable row level security;
alter table public.attendance enable row level security;
alter table public.qr_tokens enable row level security;
alter table public.face_templates enable row level security;
alter table public.attendance_sessions enable row level security;
alter table public.login_history enable row level security;
alter table public.audit_logs enable row level security;

-- Profiles
 drop policy if exists profiles_select_visible on public.profiles;
create policy profiles_select_visible on public.profiles for select to authenticated
using (public.attendx_can_view_profile(id));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

-- Subject catalog
 drop policy if exists subjects_read_authenticated on public.subjects;
create policy subjects_read_authenticated on public.subjects for select to authenticated using (status = 'ACTIVE' or created_by = auth.uid());
drop policy if exists subjects_insert_teacher on public.subjects;
create policy subjects_insert_teacher on public.subjects for insert to authenticated
with check (public.attendx_current_role() = 'teacher' and created_by = auth.uid());
drop policy if exists subjects_update_owner on public.subjects;
create policy subjects_update_owner on public.subjects for update to authenticated
using (created_by = auth.uid() and public.attendx_current_role() = 'teacher')
with check (created_by = auth.uid() and public.attendx_current_role() = 'teacher');

-- Schedules: authenticated users may discover active schedules; teachers manage their own.
drop policy if exists schedules_read_active on public.schedules;
create policy schedules_read_active on public.schedules for select to authenticated
using (status = 'ACTIVE' or teacher_id = auth.uid());
drop policy if exists schedules_insert_teacher on public.schedules;
create policy schedules_insert_teacher on public.schedules for insert to authenticated
with check (teacher_id = auth.uid() and public.attendx_current_role() = 'teacher');
drop policy if exists schedules_update_teacher on public.schedules;
create policy schedules_update_teacher on public.schedules for update to authenticated
using (teacher_id = auth.uid() and public.attendx_current_role() = 'teacher')
with check (teacher_id = auth.uid() and public.attendx_current_role() = 'teacher');
drop policy if exists schedules_delete_teacher on public.schedules;
create policy schedules_delete_teacher on public.schedules for delete to authenticated
using (teacher_id = auth.uid() and public.attendx_current_role() = 'teacher');

-- Enrollments: students can join/leave themselves; teachers can see/manage enrollments for their classes.
drop policy if exists enrollments_read_visible on public.enrollments;
create policy enrollments_read_visible on public.enrollments for select to authenticated
using (student_id = auth.uid() or exists (select 1 from public.schedules s where s.id = schedule_id and s.teacher_id = auth.uid()));
drop policy if exists enrollments_insert_self on public.enrollments;
create policy enrollments_insert_self on public.enrollments for insert to authenticated
with check (
  student_id = auth.uid()
  and public.attendx_current_role() = 'student'
  and exists (
    select 1 from public.schedules s join public.profiles p on p.id = auth.uid()
    where s.id = schedule_id and s.status = 'ACTIVE'
      and upper(trim(s.course)) = upper(trim(p.course))
      and upper(trim(s.year_level)) = upper(trim(p.year_level))
      and upper(trim(s.section)) = upper(trim(p.section))
  )
);
drop policy if exists enrollments_delete_self_or_teacher on public.enrollments;
create policy enrollments_delete_self_or_teacher on public.enrollments for delete to authenticated
using (student_id = auth.uid() or exists (select 1 from public.schedules s where s.id = schedule_id and s.teacher_id = auth.uid()));

-- Attendance is read-only to clients. Writes occur only through the guarded RPC functions below.
drop policy if exists attendance_read_visible on public.attendance;
create policy attendance_read_visible on public.attendance for select to authenticated
using (student_id = auth.uid() or exists (select 1 from public.schedules s where s.id = schedule_id and s.teacher_id = auth.uid()));

-- QR token rows are readable only by the student who owns them; the tokens are created by RPC.
drop policy if exists qr_tokens_read_self on public.qr_tokens;
create policy qr_tokens_read_self on public.qr_tokens for select to authenticated using (student_id = auth.uid());

-- A student may register/update only their own face descriptor. Teachers cannot browse descriptors directly.
drop policy if exists face_templates_read_self on public.face_templates;
create policy face_templates_read_self on public.face_templates for select to authenticated using (student_id = auth.uid());
drop policy if exists face_templates_insert_self on public.face_templates;
create policy face_templates_insert_self on public.face_templates for insert to authenticated with check (student_id = auth.uid() and public.attendx_current_role() = 'student');
drop policy if exists face_templates_update_self on public.face_templates;
create policy face_templates_update_self on public.face_templates for update to authenticated using (student_id = auth.uid()) with check (student_id = auth.uid());
drop policy if exists face_templates_delete_self on public.face_templates;
create policy face_templates_delete_self on public.face_templates for delete to authenticated using (student_id = auth.uid());

-- Teachers can read their own session rows. Session creation/closure is restricted to RPC.
drop policy if exists sessions_read_teacher on public.attendance_sessions;
create policy sessions_read_teacher on public.attendance_sessions for select to authenticated using (teacher_id = auth.uid());

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
  -- Match the active main2.py flow: one persistent random QR token per student/class.
  -- Class and teacher ownership are verified by the server when a teacher scans it.
  insert into public.qr_tokens as existing_qr(student_id, schedule_id, token)
  values (auth.uid(), p_schedule_id, 'ATTENDX-' || encode(gen_random_bytes(16), 'hex'))
  on conflict (student_id, schedule_id) do update
    set token = existing_qr.token
  returning token into v_token;
  return v_token;
end;
$$;
revoke all on function public.get_or_create_student_qr_token(text) from public, anon;
grant execute on function public.get_or_create_student_qr_token(text) to authenticated;

create or replace function public.start_attendance_session(p_schedule_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_schedule public.schedules%rowtype;
  v_local timestamp without time zone;
  v_expiry timestamp without time zone;
  v_session public.attendance_sessions%rowtype;
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then
    raise exception 'Only teachers can start attendance.';
  end if;
  select * into v_schedule from public.schedules where id = p_schedule_id and teacher_id = auth.uid() and status = 'ACTIVE';
  if not found then raise exception 'Choose one of your active class schedules.'; end if;
  v_local := timezone('Asia/Manila', now());
  if trim(to_char(v_local::date, 'FMDay')) <> v_schedule.day then
    raise exception 'This class is scheduled for %, not today.', v_schedule.day;
  end if;
  v_expiry := v_local::date + v_schedule.end_time;
  if v_local >= v_expiry then raise exception 'This class has already ended for today.'; end if;
  insert into public.attendance_sessions(schedule_id, teacher_id, session_date, expires_at, status)
  values (p_schedule_id, auth.uid(), v_local::date, v_expiry at time zone 'Asia/Manila', 'ACTIVE')
  on conflict (schedule_id, session_date) do update
    set status = 'ACTIVE', created_at = now(), expires_at = excluded.expires_at, teacher_id = auth.uid()
  returning * into v_session;
  insert into public.audit_logs(actor_id, actor_role, action, details)
  values (auth.uid(), 'teacher', 'ATTENDANCE_SESSION_STARTED', jsonb_build_object('schedule_id', p_schedule_id, 'session_id', v_session.id));
  return jsonb_build_object('id', v_session.id, 'schedule_id', v_session.schedule_id, 'session_date', v_session.session_date, 'expires_at', v_session.expires_at, 'status', v_session.status);
end;
$$;
revoke all on function public.start_attendance_session(text) from public, anon;
grant execute on function public.start_attendance_session(text) to authenticated;

create or replace function public.record_attendance(p_student_id uuid, p_schedule_id text, p_method text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_schedule public.schedules%rowtype;
  v_student public.profiles%rowtype;
  v_local timestamp without time zone;
  v_elapsed interval;
  v_status text;
  v_existing public.attendance%rowtype;
  v_saved public.attendance%rowtype;
  v_absences integer;
  v_is_teacher boolean := false;
begin
  if v_actor is null then raise exception 'Please log in first.'; end if;
  v_role := public.attendx_current_role();
  if p_method not in ('QR','FACE','FINGERPRINT') then raise exception 'Unsupported attendance method.'; end if;
  select * into v_schedule from public.schedules where id = p_schedule_id and status = 'ACTIVE';
  if not found then raise exception 'Schedule does not exist or is inactive.'; end if;
  select * into v_student from public.profiles where id = p_student_id and role = 'student';
  if not found then raise exception 'Student account was not found.'; end if;
  if v_student.status = 'INACTIVE' then raise exception 'This student account is inactive.'; end if;
  if v_role <> 'teacher' then
    raise exception 'Attendance must be verified by the teacher through the active scanner.';
  end if;
  if v_schedule.teacher_id <> v_actor then
    raise exception 'You can only record attendance for your own class.';
  end if;
  v_is_teacher := true;
  -- The active desktop entry point verifies class ownership/enrolment and duplicate status;
  -- it does not require an attendance_sessions row to exist.
  if not exists (select 1 from public.enrollments e where e.student_id = p_student_id and e.schedule_id = p_schedule_id) then
    raise exception 'Student is not enrolled in this class.';
  end if;
  v_local := timezone('Asia/Manila', now());
  v_elapsed := v_local::time - v_schedule.start_time;
  -- Match the final active status function in main2.py: early/on-start scans are PRESENT,
  -- any positive elapsed time below 15 minutes is LATE, and 15:00+ is LATE-ABSENT.
  if v_elapsed <= interval '0 seconds' then v_status := 'PRESENT';
  elsif v_elapsed < interval '15 minutes' then v_status := 'LATE';
  else v_status := 'LATE-ABSENT';
  end if;
  select * into v_existing from public.attendance
    where student_id = p_student_id and schedule_id = p_schedule_id and attendance_date = v_local::date;
  if found then
    if v_existing.status = 'ABSENT' and v_existing.method = 'SYSTEM' then
      -- Match main2.py: a system-generated no-show can be corrected by a later valid scan.
      update public.attendance set attendance_time = v_local::time, status = v_status, method = p_method
        where id = v_existing.id returning * into v_saved;
    else
      if v_student.status = 'DROPPED' then raise exception 'This student account is dropped.'; end if;
      raise exception 'Attendance already recorded today at % (%)', v_existing.attendance_time, v_existing.status;
    end if;
  else
    if v_student.status = 'DROPPED' then raise exception 'This student account is dropped.'; end if;
    insert into public.attendance(student_id, schedule_id, attendance_date, attendance_time, status, method)
      values (p_student_id, p_schedule_id, v_local::date, v_local::time, v_status, p_method)
      returning * into v_saved;
  end if;
  if v_status in ('ABSENT','LATE-ABSENT') then
    select count(*) into v_absences from public.attendance where student_id = p_student_id and status in ('ABSENT','LATE-ABSENT');
    if v_absences >= 3 then update public.profiles set status = 'DROPPED' where id = p_student_id; end if;
  end if;
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (v_actor, v_role, 'ATTENDANCE_RECORDED', jsonb_build_object('student_id', p_student_id, 'schedule_id', p_schedule_id, 'method', p_method, 'status', v_status));
  return jsonb_build_object('id', v_saved.id, 'student_id', v_saved.student_id, 'schedule_id', v_saved.schedule_id,
    'date', v_saved.attendance_date, 'time', v_saved.attendance_time, 'status', v_saved.status, 'method', v_saved.method);
end;
$$;
revoke all on function public.record_attendance(uuid, text, text) from public, anon;
grant execute on function public.record_attendance(uuid, text, text) to authenticated;

create or replace function public.mark_absent_students(p_schedule_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_schedule public.schedules%rowtype;
  v_local timestamp without time zone;
  v_inserted integer := 0;
  v_student record;
  v_count integer;
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then raise exception 'Only teachers can mark no-shows.'; end if;
  select * into v_schedule from public.schedules where id = p_schedule_id and teacher_id = auth.uid() and status = 'ACTIVE';
  if not found then raise exception 'Choose one of your active class schedules.'; end if;
  v_local := timezone('Asia/Manila', now());
  if trim(to_char(v_local::date, 'FMDay')) <> v_schedule.day then raise exception 'This schedule is not set for today.'; end if;
  if v_local::time < v_schedule.end_time then raise exception 'The class has not ended yet.'; end if;
  for v_student in
    select e.student_id from public.enrollments e
    where e.schedule_id = p_schedule_id
      and not exists (select 1 from public.attendance a where a.student_id=e.student_id and a.schedule_id=p_schedule_id and a.attendance_date=v_local::date)
  loop
    insert into public.attendance(student_id, schedule_id, attendance_date, attendance_time, status, method)
      values (v_student.student_id, p_schedule_id, v_local::date, v_schedule.end_time, 'ABSENT', 'SYSTEM')
      on conflict (student_id, schedule_id, attendance_date) do nothing;
    if found then v_inserted := v_inserted + 1; end if;
    select count(*) into v_count from public.attendance where student_id=v_student.student_id and status in ('ABSENT','LATE-ABSENT');
    if v_count >= 3 then update public.profiles set status='DROPPED' where id=v_student.student_id; end if;
  end loop;
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (auth.uid(), 'teacher', 'NO_SHOWS_MARKED', jsonb_build_object('schedule_id', p_schedule_id, 'date', v_local::date, 'inserted', v_inserted));
  return jsonb_build_object('inserted', v_inserted, 'date', v_local::date);
end;
$$;
revoke all on function public.mark_absent_students(text) from public, anon;
grant execute on function public.mark_absent_students(text) to authenticated;

create or replace function public.record_login_event()
returns void language plpgsql security definer set search_path = public as $$
declare v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then return; end if;
  select * into v_profile from public.profiles where id=auth.uid();
  if found then
    insert into public.login_history(profile_id, role, account_id) values (v_profile.id, v_profile.role, v_profile.account_id);
    insert into public.audit_logs(actor_id, actor_role, action, details) values (v_profile.id, v_profile.role, 'LOGIN', '{}'::jsonb);
  end if;
end;
$$;
revoke all on function public.record_login_event() from public, anon;
grant execute on function public.record_login_event() to authenticated;

-- Browser roles can read but never directly mutate attendance, sessions, history, or audit rows.
grant select on public.profiles, public.subjects, public.schedules, public.enrollments, public.attendance,
  public.qr_tokens, public.face_templates, public.attendance_sessions to authenticated;
grant insert, update on public.profiles to authenticated;
grant insert, update on public.subjects to authenticated;
grant insert, update, delete on public.schedules to authenticated;
grant insert, delete on public.enrollments to authenticated;
revoke insert, update, delete on public.face_templates from anon, authenticated;
grant select on public.face_templates to authenticated;
revoke insert, update, delete on public.attendance from anon, authenticated;
revoke insert, update, delete on public.qr_tokens from anon, authenticated;
revoke insert, update, delete on public.attendance_sessions from anon, authenticated;
revoke all on public.login_history, public.audit_logs from anon, authenticated;

-- Starter subject catalog, matching names used in the legacy project demo/reviewer.
insert into public.subjects(name, created_by)
values ('IT215', null), ('Database Management', null), ('Web Development', null)
on conflict (name_key) do nothing;
