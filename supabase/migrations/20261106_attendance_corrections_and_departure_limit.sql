alter table public.attendance_rules
  add column if not exists late_departure_limit_minutes integer not null default 15
    check (late_departure_limit_minutes between 0 and 360);

create or replace function public.enforce_daily_attendance_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  existing_schedule_id text;
begin
  if pg_catalog.current_setting('hadir.correcting_attendance', true) = 'on' then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(lower(new.person_name) || ':' || new.created_local_date::text, 0)
  );

  select attendance.schedule_id into existing_schedule_id
  from public.attendance
  where lower(attendance.person_name) = lower(new.person_name)
    and attendance.created_local_date = new.created_local_date
  order by attendance.created_at
  limit 1;

  if found and existing_schedule_id <> new.schedule_id then
    raise exception 'Attendance shift must match the first shift selected for this date.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

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
  p_schedule_id text,
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
  affected_record public.attendance%rowtype;
  selected_schedule public.attendance_schedules%rowtype;
  lock_date date;
begin
  if p_attendance_type is null or p_attendance_type not in ('datang', 'pulang') or
      p_created_at is null or p_created_local_date is null or p_note is null or
      p_reason is null or pg_catalog.btrim(p_reason) = '' or
      p_schedule_id is null or pg_catalog.btrim(p_schedule_id) = '' or
      p_admin_username is null or pg_catalog.btrim(p_admin_username) = '' then
    raise exception 'Invalid attendance correction data.' using errcode = '22023';
  end if;

  select * into selected_schedule
  from public.attendance_schedules
  where id = p_schedule_id;
  if not found then
    raise exception 'Attendance schedule not found.' using errcode = 'P0003';
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
      old_record.note is not distinct from p_note and
      old_record.schedule_id is not distinct from p_schedule_id then
    raise exception 'Attendance correction has no changes.' using errcode = 'P0001';
  end if;

  for lock_date in
    select dates.date_value
    from (values (old_record.created_local_date), (p_created_local_date)) as dates(date_value)
    group by dates.date_value
    order by dates.date_value
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.lower(old_record.person_name) || ':' || lock_date::text,
        0
      )
    );
  end loop;

  if p_created_local_date is distinct from old_record.created_local_date and exists (
    select 1
    from public.attendance as target_day
    where pg_catalog.lower(target_day.person_name) = pg_catalog.lower(old_record.person_name)
      and target_day.created_local_date = p_created_local_date
      and target_day.schedule_id is distinct from p_schedule_id
  ) then
    raise exception 'Attendance shift conflicts with target date.' using errcode = '23514';
  end if;

  perform pg_catalog.set_config('hadir.correcting_attendance', 'on', true);
  for affected_record in
    select *
    from public.attendance
    where pg_catalog.lower(person_name) = pg_catalog.lower(old_record.person_name)
      and created_local_date = old_record.created_local_date
    order by id
    for update
  loop
    if affected_record.id = p_attendance_id or
        affected_record.schedule_id is distinct from p_schedule_id then
      update public.attendance
      set attendance_type = case when id = p_attendance_id then p_attendance_type else attendance_type end,
          created_at = case when id = p_attendance_id then p_created_at else created_at end,
          created_local_date = case when id = p_attendance_id then p_created_local_date else created_local_date end,
          note = case when id = p_attendance_id then p_note else note end,
          schedule_id = p_schedule_id,
          schedule_label = case when schedule_id is distinct from p_schedule_id
            then selected_schedule.label else schedule_label end,
          schedule_start_time = case when schedule_id is distinct from p_schedule_id
            then selected_schedule.start_time else schedule_start_time end,
          schedule_end_time = case when schedule_id is distinct from p_schedule_id
            then selected_schedule.end_time else schedule_end_time end
      where id = affected_record.id
      returning * into corrected_record;

      insert into public.attendance_correction_audit (
        attendance_id, admin_username, reason, old_values, new_values
      ) values (
        affected_record.id,
        pg_catalog.btrim(p_admin_username),
        pg_catalog.btrim(p_reason),
        pg_catalog.jsonb_build_object(
          'attendanceType', affected_record.attendance_type,
          'createdAt', affected_record.created_at,
          'createdLocalDate', affected_record.created_local_date,
          'note', affected_record.note,
          'scheduleId', affected_record.schedule_id,
          'scheduleLabel', affected_record.schedule_label,
          'scheduleStartTime', affected_record.schedule_start_time,
          'scheduleEndTime', affected_record.schedule_end_time
        ),
        pg_catalog.jsonb_build_object(
          'attendanceType', corrected_record.attendance_type,
          'createdAt', corrected_record.created_at,
          'createdLocalDate', corrected_record.created_local_date,
          'note', corrected_record.note,
          'scheduleId', corrected_record.schedule_id,
          'scheduleLabel', corrected_record.schedule_label,
          'scheduleStartTime', corrected_record.schedule_start_time,
          'scheduleEndTime', corrected_record.schedule_end_time
        )
      );
    end if;
  end loop;
  perform pg_catalog.set_config('hadir.correcting_attendance', 'off', true);

  return pg_catalog.jsonb_build_object('attendanceId', p_attendance_id);
end;
$$;

drop function if exists public.correct_attendance(bigint, text, timestamptz, date, text, text, text);
revoke all on function public.correct_attendance(bigint, text, timestamptz, date, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.correct_attendance(bigint, text, timestamptz, date, text, text, text, text)
  to service_role;
grant select on public.attendance_correction_audit to service_role;

alter table public.attendance_correction_audit enable row level security;
