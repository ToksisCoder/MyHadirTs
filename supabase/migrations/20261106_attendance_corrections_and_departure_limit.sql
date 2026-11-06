alter table public.attendance_rules
  add column if not exists late_departure_limit_minutes integer not null default 15
    check (late_departure_limit_minutes between 0 and 360);

create table if not exists public.attendance_correction_audit (
  id bigint generated always as identity primary key,
  attendance_id bigint not null,
  admin_username text not null,
  reason text not null,
  old_values jsonb not null,
  new_values jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists attendance_correction_audit_record_id_idx
  on public.attendance_correction_audit (attendance_id, id desc);

create or replace function public.correct_attendance(
  p_attendance_id bigint,
  p_attendance_type text,
  p_created_at timestamptz,
  p_created_local_date date,
  p_note text,
  p_reason text,
  p_admin_username text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_record public.attendance%rowtype;
  corrected_record public.attendance%rowtype;
begin
  if p_attendance_type is null or p_attendance_type not in ('datang', 'pulang') or
      p_created_at is null or p_created_local_date is null or p_note is null or
      p_reason is null or pg_catalog.btrim(p_reason) = '' or
      p_admin_username is null or pg_catalog.btrim(p_admin_username) = '' then
    raise exception 'Invalid attendance correction data.' using errcode = '22023';
  end if;

  select * into old_record
  from public.attendance
  where id = p_attendance_id
  for update;
  if not found then
    raise exception 'Attendance record not found.' using errcode = 'P0002';
  end if;

  if old_record.attendance_type is not distinct from p_attendance_type and
      old_record.created_at is not distinct from p_created_at and
      old_record.created_local_date is not distinct from p_created_local_date and
      old_record.note is not distinct from p_note then
    raise exception 'Attendance correction has no changes.' using errcode = 'P0001';
  end if;

  update public.attendance
  set attendance_type = p_attendance_type,
      created_at = p_created_at,
      created_local_date = p_created_local_date,
      note = p_note
  where id = p_attendance_id
  returning * into corrected_record;

  insert into public.attendance_correction_audit (
    attendance_id, admin_username, reason, old_values, new_values
  ) values (
    p_attendance_id,
    pg_catalog.btrim(p_admin_username),
    pg_catalog.btrim(p_reason),
    pg_catalog.jsonb_build_object(
      'attendanceType', old_record.attendance_type,
      'createdAt', old_record.created_at,
      'createdLocalDate', old_record.created_local_date,
      'note', old_record.note
    ),
    pg_catalog.jsonb_build_object(
      'attendanceType', corrected_record.attendance_type,
      'createdAt', corrected_record.created_at,
      'createdLocalDate', corrected_record.created_local_date,
      'note', corrected_record.note
    )
  );

  return pg_catalog.jsonb_build_object('attendanceId', p_attendance_id);
end;
$$;

revoke all on function public.correct_attendance(bigint, text, timestamptz, date, text, text, text)
  from public, anon, authenticated;
grant execute on function public.correct_attendance(bigint, text, timestamptz, date, text, text, text)
  to service_role;
grant select on public.attendance_correction_audit to service_role;

alter table public.attendance_correction_audit enable row level security;
