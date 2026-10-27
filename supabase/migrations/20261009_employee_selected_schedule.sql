create table if not exists public.attendance_schedules (
  id text primary key,
  label text not null unique,
  start_time text not null,
  end_time text not null,
  check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (end_time > start_time)
);

insert into public.attendance_schedules (id, label, start_time, end_time)
values
  ('employee-morning', 'Karyawan Shift Pagi', '07:00', '17:00'),
  ('employee-afternoon', 'Karyawan Shift Siang', '14:00', '22:00'),
  ('admin-1', 'Admin 1', '07:00', '17:00'),
  ('admin-2', 'Admin 2', '09:00', '18:00'),
  ('coordinator', 'Koordinator', '11:00', '19:30')
on conflict (id) do nothing;

alter table public.attendance
  add column if not exists schedule_id text references public.attendance_schedules(id);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'people' and column_name = 'schedule_id'
  ) then
    execute $backfill$
      update public.attendance as attendance
      set schedule_id = coalesce(people.schedule_id, 'employee-morning')
      from public.people as people
      where lower(people.name) = lower(attendance.person_name)
        and attendance.schedule_id is null
    $backfill$;
  end if;
end;
$$;

update public.attendance
set schedule_id = 'employee-morning'
where schedule_id is null;

alter table public.attendance
  alter column schedule_id set default 'employee-morning',
  alter column schedule_id set not null;

create or replace function public.enforce_daily_attendance_schedule()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  existing_schedule_id text;
begin
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

drop trigger if exists attendance_schedule_consistency on public.attendance;
create trigger attendance_schedule_consistency
before insert or update
on public.attendance
for each row execute function public.enforce_daily_attendance_schedule();
