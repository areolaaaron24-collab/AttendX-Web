-- AttendX Flet compatibility additions for the existing AttendX-Web schema.
-- Review this migration before applying it to the shared Supabase project.
-- This migration does not create a second schema or rename existing web tables.

-- Correct the authoritative attendance boundary: before start is rejected,
-- exactly at start is PRESENT, start+1 second through +14:59 is LATE,
-- and start+15:00 onward is LATE-ABSENT.
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
begin
  if v_actor is null then raise exception 'Please log in first.'; end if;
  v_role := public.attendx_current_role();
  if p_method not in ('QR','FACE','FINGERPRINT','MANUAL') then raise exception 'Unsupported attendance method.'; end if;

  select * into v_schedule
    from public.schedules
    where id = p_schedule_id and status = 'ACTIVE';
  if not found then raise exception 'Schedule does not exist or is inactive.'; end if;

  select * into v_student
    from public.profiles
    where id = p_student_id and role = 'student';
  if not found then raise exception 'Student account was not found.'; end if;
  if v_student.status = 'INACTIVE' then raise exception 'This student account is inactive.'; end if;
  if v_role <> 'teacher' then
    raise exception 'Attendance must be verified by the teacher through the active scanner.';
  end if;
  if v_schedule.teacher_id <> v_actor then
    raise exception 'You can only record attendance for your own class.';
  end if;
  if not exists (
    select 1 from public.enrollments e
    where e.student_id = p_student_id and e.schedule_id = p_schedule_id
  ) then
    raise exception 'Student is not enrolled in this class.';
  end if;

  v_local := timezone('Asia/Manila', now());
  if trim(to_char(v_local::date, 'FMDay')) <> v_schedule.day then
    raise exception 'This class is scheduled for %, not today.', v_schedule.day;
  end if;
  v_elapsed := v_local::time - v_schedule.start_time;
  if v_elapsed < interval '0 seconds' then
    raise exception 'Attendance cannot be recorded before the scheduled start time.';
  elsif v_elapsed = interval '0 seconds' then
    v_status := 'PRESENT';
  elsif v_elapsed < interval '15 minutes' then
    v_status := 'LATE';
  else
    v_status := 'LATE-ABSENT';
  end if;

  select * into v_existing from public.attendance
    where student_id = p_student_id
      and schedule_id = p_schedule_id
      and attendance_date = v_local::date;
  if found then
    if v_existing.status = 'ABSENT' and v_existing.method = 'SYSTEM' then
      update public.attendance
        set attendance_time = v_local::time, status = v_status, method = p_method
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
    select count(*) into v_absences from public.attendance
      where student_id = p_student_id and status in ('ABSENT','LATE-ABSENT');
    if v_absences >= 3 then
      update public.profiles set status = 'DROPPED' where id = p_student_id;
    end if;
  end if;

  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (v_actor, v_role, 'ATTENDANCE_RECORDED',
      jsonb_build_object('student_id', p_student_id, 'schedule_id', p_schedule_id,
                         'method', p_method, 'status', v_status));
  return jsonb_build_object('id', v_saved.id, 'student_id', v_saved.student_id,
    'schedule_id', v_saved.schedule_id, 'date', v_saved.attendance_date,
    'time', v_saved.attendance_time, 'status', v_saved.status, 'method', v_saved.method);
end;
$$;
revoke all on function public.record_attendance(uuid, text, text) from public, anon;
grant execute on function public.record_attendance(uuid, text, text) to authenticated;

-- Flet's desktop face_recognition model uses a different 128-D descriptor from
-- browser face-api. Keep the model version separate and expose only enrolled
-- students' Flet descriptors to the teacher who owns the selected active schedule.
create or replace function public.attendx_face_templates_for_schedule(p_schedule_id text)
returns table(student_id uuid, embedding double precision[])
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then
    raise exception 'Only teachers can load class face templates.';
  end if;
  if not exists (
    select 1 from public.schedules s
    where s.id = p_schedule_id and s.teacher_id = auth.uid() and s.status = 'ACTIVE'
  ) then
    raise exception 'You can only load face templates for your own active schedule.';
  end if;

  return query
    select ft.student_id, ft.descriptor as embedding
    from public.face_templates ft
    join public.enrollments e on e.student_id = ft.student_id
    where e.schedule_id = p_schedule_id
      and ft.model_version = 'face_recognition-128d-v1'
    order by ft.student_id;
end;
$$;
revoke all on function public.attendx_face_templates_for_schedule(text) from public, anon;
grant execute on function public.attendx_face_templates_for_schedule(text) to authenticated;


-- Allow teacher-entered corrections only through the audited server-side RPC below.
alter table public.attendance drop constraint if exists attendance_method_check;
alter table public.attendance add constraint attendance_method_check
  check (method in ('QR','FACE','FINGERPRINT','SYSTEM','MANUAL'));

-- Return the server-created session token to the authenticated teacher so the
-- Flet app can display a real QR, never a client-invented token.
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
  select * into v_schedule from public.schedules
    where id = p_schedule_id and teacher_id = auth.uid() and status = 'ACTIVE';
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
    values (auth.uid(), 'teacher', 'ATTENDANCE_SESSION_STARTED',
      jsonb_build_object('schedule_id', p_schedule_id, 'session_id', v_session.id));
  return jsonb_build_object(
    'id', v_session.id, 'session_id', v_session.id,
    'schedule_id', v_session.schedule_id, 'session_date', v_session.session_date,
    'expires_at', v_session.expires_at, 'ends_at', v_session.expires_at,
    'raw_token', v_session.session_token::text, 'status', v_session.status
  );
end;
$$;
revoke all on function public.start_attendance_session(text) from public, anon;
grant execute on function public.start_attendance_session(text) to authenticated;

create or replace function public.close_attendance_session(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.attendance_sessions%rowtype;
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then
    raise exception 'Only teachers can close attendance sessions.';
  end if;
  update public.attendance_sessions
    set status = 'CLOSED'
    where id = p_session_id and teacher_id = auth.uid()
    returning * into v_session;
  if not found then raise exception 'Session not found or not owned by this teacher.'; end if;
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (auth.uid(), 'teacher', 'ATTENDANCE_SESSION_CLOSED',
      jsonb_build_object('schedule_id', v_session.schedule_id, 'session_id', v_session.id));
  return jsonb_build_object('ok', true, 'message', 'Attendance session closed.', 'session_id', v_session.id);
end;
$$;
revoke all on function public.close_attendance_session(uuid) from public, anon;
grant execute on function public.close_attendance_session(uuid) to authenticated;

create or replace function public.record_session_qr_attendance(p_token_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_student_id uuid := auth.uid();
  v_session public.attendance_sessions%rowtype;
  v_schedule public.schedules%rowtype;
  v_student public.profiles%rowtype;
  v_local timestamp without time zone;
  v_elapsed interval;
  v_status text;
  v_existing public.attendance%rowtype;
  v_saved public.attendance%rowtype;
  v_absences integer;
begin
  if v_student_id is null or public.attendx_current_role() <> 'student' then
    raise exception 'Please sign in with your student account to scan a class QR.';
  end if;
  select * into v_session from public.attendance_sessions
    where session_token::text = trim(p_token_text)
      and status = 'ACTIVE' and expires_at > now()
      and session_date = timezone('Asia/Manila', now())::date;
  if not found then raise exception 'This class QR is expired or invalid.'; end if;
  select * into v_schedule from public.schedules
    where id = v_session.schedule_id and status = 'ACTIVE';
  if not found then raise exception 'This class schedule is inactive.'; end if;
  if not exists (
    select 1 from public.enrollments e
    where e.student_id = v_student_id and e.schedule_id = v_session.schedule_id
  ) then raise exception 'Join this class before scanning its QR.'; end if;
  select * into v_student from public.profiles where id = v_student_id;
  if not found or v_student.status <> 'ACTIVE' then raise exception 'This student account is inactive or dropped.'; end if;

  v_local := timezone('Asia/Manila', now());
  v_elapsed := v_local::time - v_schedule.start_time;
  if v_elapsed < interval '0 seconds' then
    raise exception 'Attendance cannot be recorded before the scheduled start time.';
  elsif v_elapsed = interval '0 seconds' then
    v_status := 'PRESENT';
  elsif v_elapsed < interval '15 minutes' then
    v_status := 'LATE';
  else
    v_status := 'LATE-ABSENT';
  end if;

  select * into v_existing from public.attendance
    where student_id = v_student_id and schedule_id = v_session.schedule_id
      and attendance_date = v_local::date;
  if found then
    if v_existing.status = 'ABSENT' and v_existing.method = 'SYSTEM' then
      update public.attendance set attendance_time = v_local::time, status = v_status, method = 'QR'
        where id = v_existing.id returning * into v_saved;
    else
      raise exception 'Attendance already recorded today at % (%)', v_existing.attendance_time, v_existing.status;
    end if;
  else
    insert into public.attendance(student_id, schedule_id, attendance_date, attendance_time, status, method)
      values (v_student_id, v_session.schedule_id, v_local::date, v_local::time, v_status, 'QR')
      returning * into v_saved;
  end if;

  if v_status = 'LATE-ABSENT' then
    select count(*) into v_absences from public.attendance
      where student_id = v_student_id and status in ('ABSENT','LATE-ABSENT');
    if v_absences >= 3 then update public.profiles set status = 'DROPPED' where id = v_student_id; end if;
  end if;
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (v_student_id, 'student', 'ATTENDANCE_RECORDED',
      jsonb_build_object('student_id', v_student_id, 'schedule_id', v_session.schedule_id,
                         'method', 'QR', 'status', v_status, 'session_id', v_session.id));
  return jsonb_build_object('id', v_saved.id, 'student_id', v_saved.student_id,
    'schedule_id', v_saved.schedule_id, 'date', v_saved.attendance_date,
    'time', v_saved.attendance_time, 'status', v_saved.status, 'method', v_saved.method);
end;
$$;
revoke all on function public.record_session_qr_attendance(text) from public, anon;
grant execute on function public.record_session_qr_attendance(text) to authenticated;

create or replace function public.record_manual_attendance(p_student_id uuid, p_schedule_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then
    raise exception 'Only teachers can record manual attendance corrections.';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Enter an audit reason of at least 10 characters.';
  end if;
  v_result := public.record_attendance(p_student_id, p_schedule_id, 'MANUAL');
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (auth.uid(), 'teacher', 'MANUAL_ATTENDANCE_REASON',
      jsonb_build_object('student_id', p_student_id, 'schedule_id', p_schedule_id, 'reason', btrim(p_reason)));
  return v_result || jsonb_build_object('message', 'Manual attendance recorded with an audit reason.');
end;
$$;
revoke all on function public.record_manual_attendance(uuid, text, text) from public, anon;
grant execute on function public.record_manual_attendance(uuid, text, text) to authenticated;


-- Generic authenticated audit event used by the desktop UI. Business-critical
-- attendance events are still written by their own guarded database functions.
create or replace function public.write_audit_event(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_id uuid;
begin
  v_id := auth.uid();
  if v_id is null then raise exception 'Please log in first.'; end if;
  v_role := public.attendx_current_role();
  if v_role not in ('teacher','student') then raise exception 'Unsupported account role.'; end if;
  if length(btrim(coalesce(p_action, ''))) < 1 or length(btrim(p_action)) > 120 then
    raise exception 'Audit action is required and must be 120 characters or fewer.';
  end if;
  insert into public.audit_logs(actor_id, actor_role, action, details)
    values (v_id, v_role, btrim(p_action),
      jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id)
      || coalesce(p_details, '{}'::jsonb));
  return jsonb_build_object('ok', true, 'action', btrim(p_action));
end;
$$;
revoke all on function public.write_audit_event(text, text, text, jsonb) from public, anon;
grant execute on function public.write_audit_event(text, text, text, jsonb) to authenticated;

create or replace function public.attendx_health_check()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  return jsonb_build_object(
    'ok', true,
    'message', 'AttendX Supabase database is reachable.',
    'role', public.attendx_current_role(),
    'checked_at', now()
  );
end;
$$;
revoke all on function public.attendx_health_check() from public, anon;
grant execute on function public.attendx_health_check() to authenticated;
