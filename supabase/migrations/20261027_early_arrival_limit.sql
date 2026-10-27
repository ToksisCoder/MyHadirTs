alter table public.attendance_rules
  add column if not exists early_limit_minutes integer not null default 15
    check (early_limit_minutes between 0 and 360);
