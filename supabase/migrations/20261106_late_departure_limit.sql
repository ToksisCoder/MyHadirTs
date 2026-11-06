alter table public.attendance_rules
  add column if not exists late_departure_limit_minutes integer not null default 15
    check (late_departure_limit_minutes between 0 and 360);
