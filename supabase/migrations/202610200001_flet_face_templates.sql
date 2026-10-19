-- Isolated desktop face templates for AttendX-Flet.
-- The browser app uses face-api descriptors in public.face_templates. Those descriptors
-- must never be overwritten by Python face_recognition descriptors, even though both
-- models produce 128 values.
create table if not exists public.flet_face_templates (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  descriptor double precision[] not null,
  model_version text not null default 'face_recognition-128d-v1'
    check (model_version = 'face_recognition-128d-v1'),
  updated_at timestamptz not null default now(),
  constraint flet_face_descriptor_length check (cardinality(descriptor) = 128)
);

alter table public.flet_face_templates enable row level security;

grant select, insert, update, delete on public.flet_face_templates to authenticated;

drop policy if exists "Students can read own Flet face template" on public.flet_face_templates;
create policy "Students can read own Flet face template"
  on public.flet_face_templates for select to authenticated
  using (student_id = auth.uid());

drop policy if exists "Students can register own Flet face template" on public.flet_face_templates;
create policy "Students can register own Flet face template"
  on public.flet_face_templates for insert to authenticated
  with check (
    student_id = auth.uid()
    and public.attendx_current_role() = 'student'
  );

drop policy if exists "Students can update own Flet face template" on public.flet_face_templates;
create policy "Students can update own Flet face template"
  on public.flet_face_templates for update to authenticated
  using (
    student_id = auth.uid()
    and public.attendx_current_role() = 'student'
  )
  with check (
    student_id = auth.uid()
    and public.attendx_current_role() = 'student'
  );

drop policy if exists "Students can delete own Flet face template" on public.flet_face_templates;
create policy "Students can delete own Flet face template"
  on public.flet_face_templates for delete to authenticated
  using (
    student_id = auth.uid()
    and public.attendx_current_role() = 'student'
  );

create or replace function public.attendx_face_templates_for_schedule(p_schedule_id text)
returns table(student_id uuid, embedding double precision[])
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or public.attendx_current_role() <> 'teacher' then
    raise exception 'Only teachers can load class face templates.';
  end if;

  if not exists (
    select 1 from public.schedules s
    where s.id = p_schedule_id
      and s.teacher_id = auth.uid()
      and s.status = 'ACTIVE'
  ) then
    raise exception 'You can only load face templates for your own active schedule.';
  end if;

  return query
    select ft.student_id, ft.descriptor
    from public.flet_face_templates ft
    join public.enrollments e on e.student_id = ft.student_id
    where e.schedule_id = p_schedule_id
      and ft.model_version = 'face_recognition-128d-v1'
    order by ft.student_id;
end;
$$;

revoke all on function public.attendx_face_templates_for_schedule(text) from public, anon;
grant execute on function public.attendx_face_templates_for_schedule(text) to authenticated;
