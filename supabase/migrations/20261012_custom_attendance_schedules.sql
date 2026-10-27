alter table public.attendance
  add column if not exists schedule_label text;

update public.attendance as attendance
set schedule_label = schedules.label
from public.attendance_schedules as schedules
where schedules.id = attendance.schedule_id
  and attendance.schedule_label is null;

update public.attendance
set schedule_label = 'Jadwal tidak diketahui'
where schedule_label is null;

alter table public.attendance
  alter column schedule_label set not null;

create unique index if not exists attendance_schedules_label_case_insensitive
  on public.attendance_schedules (lower(label));
