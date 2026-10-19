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
  if p_method not in ('QR','FACE','FINGERPRINT') then raise exception 'Unsupported attendance method.'; end if;

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
