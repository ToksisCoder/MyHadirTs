create index if not exists attendance_person_date_id_idx
  on public.attendance (person_name, created_local_date, id desc);
