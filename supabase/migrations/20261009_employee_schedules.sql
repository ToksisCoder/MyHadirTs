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

alter table public.people
  add column if not exists schedule_id text references public.attendance_schedules(id);

update public.people
set schedule_id = 'employee-morning'
where schedule_id is null;

alter table public.people
  alter column schedule_id set default 'employee-morning',
  alter column schedule_id set not null;

alter table public.attendance_schedules enable row level security;
