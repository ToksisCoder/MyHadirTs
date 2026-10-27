alter table public.attendance
  add column if not exists schedule_start_time text,
  add column if not exists schedule_end_time text;

update public.attendance as attendance
set schedule_start_time = coalesce(schedules.start_time, '07:00'),
    schedule_end_time = coalesce(schedules.end_time, '17:00')
from public.attendance_schedules as schedules
where schedules.id = attendance.schedule_id
  and (attendance.schedule_start_time is null or attendance.schedule_end_time is null);

update public.attendance
set schedule_start_time = coalesce(schedule_start_time, '07:00'),
    schedule_end_time = coalesce(schedule_end_time, '17:00')
where schedule_start_time is null or schedule_end_time is null;

alter table public.attendance
  alter column schedule_start_time set not null,
  alter column schedule_end_time set not null;
