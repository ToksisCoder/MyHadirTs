"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const PORT = Number.parseInt(process.env.PORT || "5080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PHOTO_SIZE = 3.5 * 1024 * 1024;
const SESSION_COOKIE = "Absensi.Admin";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const DEFAULT_TIME_ZONE = "Asia/Makassar";
const SCHEDULE_ORDER = ["employee-morning", "employee-afternoon", "admin-1", "admin-2", "coordinator"];
const configuredTimeZone = (process.env.APP_TIME_ZONE || "")
  .trim()
  .replace(/^(['"])(.*)\1$/, "$2")
  .trim();
let APP_TIME_ZONE = configuredTimeZone || DEFAULT_TIME_ZONE;
const STATIC_DIRECTORY = path.join(__dirname, "wwwroot");
const PHOTO_BUCKET = "attendance-photos";
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_SIZE, files: 1, fields: 5, fieldSize: 512 * 1024 }
});
let supabase;
let sessionSecret;

try {
  new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE });
} catch {
  console.warn(
    `Invalid APP_TIME_ZONE ${JSON.stringify(process.env.APP_TIME_ZONE)}; using ${DEFAULT_TIME_ZONE}.`
  );
  APP_TIME_ZONE = DEFAULT_TIME_ZONE;
}

function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.");
  }
  supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return supabase;
}

function getSessionSecret() {
  if (sessionSecret) return sessionSecret;
  const configuredSecret = process.env.SESSION_SECRET;
  if (!configuredSecret || Buffer.byteLength(configuredSecret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  sessionSecret = Buffer.from(configuredSecret, "utf8");
  return sessionSecret;
}

function unwrap(result) {
  if (result.error) throw result.error;
  return result.data;
}

async function fetchAllRows(queryFactory) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = unwrap(await queryFactory().range(offset, offset + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

function zonedParts(value = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}

function localDate(value = new Date()) {
  const { year, month, day } = zonedParts(value);
  return `${year}-${month}-${day}`;
}

function dateOffset(value, offset) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function timeToMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function attendanceMinutes(createdAt) {
  const { hour, minute } = zonedParts(new Date(createdAt));
  return Number(hour) * 60 + Number(minute);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function derivePasswordHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 32_768, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function verifyPasswordHash(password, salt, scheme) {
  if (scheme === "pbkdf2") {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(password, salt, 310_000, 32, "sha256", (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  }
  return derivePasswordHash(password, salt);
}

async function getAttendanceRules() {
  const row = unwrap(await getSupabase().from("attendance_rules")
    .select("tolerance_minutes,late_limit_minutes,early_limit_minutes")
    .eq("id", 1)
    .single());
  return {
    toleranceMinutes: row.tolerance_minutes,
    lateLimitMinutes: row.late_limit_minutes,
    earlyLimitMinutes: row.early_limit_minutes
  };
}

async function getAttendanceSchedules() {
  const schedules = await fetchAllRows(() => getSupabase().from("attendance_schedules")
    .select("id,label,start_time,end_time")
    .order("id"));
  return schedules.sort((left, right) => {
    const leftOrder = SCHEDULE_ORDER.indexOf(left.id);
    const rightOrder = SCHEDULE_ORDER.indexOf(right.id);
    if (leftOrder === -1 && rightOrder === -1) return left.label.localeCompare(right.label, "id");
    if (leftOrder === -1) return 1;
    if (rightOrder === -1) return -1;
    return leftOrder - rightOrder;
  });
}

function publicSchedule(row) {
  return {
    id: row.id,
    label: row.label,
    startTime: row.start_time,
    endTime: row.end_time
  };
}

function publicField(row) {
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    options: row.options_json,
    required: row.required
  };
}

function publicPerson(row) {
  return { id: row.id, name: row.name };
}

async function hasAdmin() {
  const result = await getSupabase().from("admins").select("id").eq("id", 1).maybeSingle();
  return Boolean(unwrap(result));
}

function hasValidImageSignature(bytes, contentType) {
  switch (contentType) {
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    case "image/webp":
      return bytes.length >= 12 &&
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
    default:
      return false;
  }
}

function sendError(response, status, message) {
  return response.status(status).json({ error: message });
}

function validateCredentials(username, password) {
  const trimmedUsername = typeof username === "string" ? username.trim() : "";
  if (trimmedUsername.length < 3 || trimmedUsername.length > 40 ||
      !/^[a-zA-Z0-9_.-]+$/.test(trimmedUsername)) {
    return "Username harus terdiri dari 3–40 huruf, angka, titik, garis bawah, atau tanda hubung.";
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 200) {
    return "Kata sandi harus terdiri dari minimal 12 karakter.";
  }
  return null;
}

function parseCookie(request, cookieName) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const prefix = `${cookieName}=`;
  const cookie = cookies.find(value => value.trim().startsWith(prefix));
  return cookie ? cookie.trim().slice(prefix.length) : null;
}

function signPayload(payload) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

async function adminUser(request) {
  const token = parseCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(signPayload(payload), "base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!session || typeof session.username !== "string" ||
      !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) return null;

  const admin = unwrap(await getSupabase().from("admins")
    .select("username,password_hash")
    .eq("id", 1)
    .maybeSingle());
  if (!admin || admin.username.toLowerCase() !== session.username.toLowerCase() ||
      admin.password_hash !== session.passwordHash) return null;
  return admin.username;
}

function setAdminCookie(request, response, username, passwordHash) {
  const payload = Buffer.from(JSON.stringify({
    username,
    passwordHash,
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000
  })).toString("base64url");
  const value = `${payload}.${signPayload(payload)}`;
  const secure = process.env.COOKIE_SECURE === "true" || request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_DURATION_SECONDS}; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

function clearAdminCookie(request, response) {
  const secure = process.env.COOKIE_SECURE === "true" || request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure}`
  );
}

async function requireAdmin(request, response, next) {
  try {
    const username = await adminUser(request);
    if (!username) return sendError(response, 401, "Silakan masuk sebagai admin.");
    request.adminUsername = username;
    return next();
  } catch (error) {
    return next(error);
  }
}

function limitAttendanceRequest(request, response, next) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PHOTO_SIZE + 576 * 1024) {
    return sendError(response, 413, "Ukuran formulir dan foto melebihi batas.");
  }
  return next();
}

async function limitAdminAuthentication(request, response, next) {
  try {
    const address = request.ip || request.socket.remoteAddress || "unknown";
    const attemptKey = crypto.createHmac("sha256", getSessionSecret()).update(address).digest("hex");
    const count = unwrap(await getSupabase().rpc("register_admin_auth_attempt", {
      p_attempt_key: attemptKey
    }));
    if (count > 5) return sendError(response, 429, "Terlalu banyak percobaan. Coba lagi dalam satu menit.");
    return next();
  } catch (error) {
    return next(error);
  }
}

async function dashboardData() {
  const today = localDate();
  const firstDay = dateOffset(today, -6);
  const database = getSupabase();
  const [totalResult, todayResult, weekResult, dailyRows, fieldsRows, peopleRows, schedulesRows, rules] = await Promise.all([
    database.from("attendance").select("id", { count: "exact", head: true }),
    database.from("attendance").select("id", { count: "exact", head: true }).eq("created_local_date", today),
    database.from("attendance").select("id", { count: "exact", head: true }).gte("created_local_date", firstDay).lte("created_local_date", today),
    fetchAllRows(() => database.from("attendance").select("created_local_date").gte("created_local_date", firstDay).lte("created_local_date", today).order("created_local_date")),
    database.from("custom_fields").select("id,label,type,options_json,required").order("id"),
    database.from("people").select("id,name").order("name"),
    getAttendanceSchedules(),
    getAttendanceRules()
  ]);
  const dailyCountsMap = new Map();
  for (const row of dailyRows) {
    dailyCountsMap.set(row.created_local_date, (dailyCountsMap.get(row.created_local_date) ?? 0) + 1);
  }
  const dailyCounts = Array.from({ length: 7 }, (_, offset) => {
    const date = dateOffset(firstDay, offset);
    return { date, count: dailyCountsMap.get(date) ?? 0 };
  });
  const fields = unwrap(fieldsRows).map(publicField);
  const schedules = schedulesRows.map(publicSchedule);

  return {
    today,
    stats: {
      total: totalResult.count ?? 0,
      today: todayResult.count ?? 0,
      lastSevenDays: weekResult.count ?? 0
    },
    dailyCounts,
    rules,
    people: unwrap(peopleRows).map(publicPerson),
    schedules,
    fields
  };
}

async function monthlyAttendanceSummary(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const today = localDate();
  const now = zonedParts();
  const isCurrentMonth = month === today.slice(0, 7);
  const lastCalendarDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const rules = await getAttendanceRules();
  const schedules = (await getAttendanceSchedules()).map(publicSchedule);
  const nowMinutes = Number(now.hour) * 60 + Number(now.minute);
  const daysToInclude = isCurrentMonth
    ? Number(today.slice(8, 10)) - 1
    : lastCalendarDay;

  const queryEndDay = isCurrentMonth ? Number(today.slice(8, 10)) : daysToInclude;
  const endDate = `${month}-${String(Math.max(queryEndDay, 1)).padStart(2, "0")}`;
  const database = getSupabase();
  const [records, people] = await Promise.all([
    queryEndDay > 0
      ? fetchAllRows(() => database.from("attendance")
        .select("person_name,attendance_type,created_at,created_local_date,schedule_id,schedule_label,schedule_start_time,schedule_end_time")
        .gte("created_local_date", `${month}-01`)
        .lte("created_local_date", endDate)
        .order("created_local_date")
        .order("created_at"))
      : Promise.resolve([]),
    fetchAllRows(() => database.from("people").select("name,created_local_date").order("name"))
  ]);
  const schedulesById = new Map(schedules.map(schedule => [schedule.id, schedule]));
  const latestShiftEnd = Math.max(...schedules.map(schedule => timeToMinutes(schedule.endTime)));
  const currentDayIncluded = isCurrentMonth && nowMinutes >= latestShiftEnd;
  const byPerson = new Map();
  for (const record of records) {
    const personKey = record.person_name.toLocaleLowerCase();
    if (!byPerson.has(personKey)) byPerson.set(personKey, new Map());
    const days = byPerson.get(personKey);
    if (!days.has(record.created_local_date)) days.set(record.created_local_date, {});
    const events = days.get(record.created_local_date);
    if (!events[record.attendance_type]) events[record.attendance_type] = [];
    events[record.attendance_type].push(record);
  }

  const employees = people.map(person => {
    const days = byPerson.get(person.name.toLocaleLowerCase()) ?? new Map();
    const summary = {
      name: person.name,
      scheduleLabels: new Set(),
      present: 0,
      late: 0,
      early: 0,
      earlyBonus: 0,
      lateDeparture: 0,
      absent: 0
    };
    const countArrival = arrival => {
      if (!arrival) {
        summary.absent += 1;
        return;
      }
      const minutesLate = attendanceMinutes(arrival.created_at) - timeToMinutes(arrival.schedule_start_time);
      if (minutesLate > rules.lateLimitMinutes) {
        summary.absent += 1;
        return;
      }
      summary.present += 1;
      if (minutesLate > rules.toleranceMinutes) summary.late += 1;
      else if (minutesLate < 0) {
        summary.early += 1;
        if (minutesLate < -rules.earlyLimitMinutes) summary.earlyBonus += 1;
      }
    };
    const joinedAfterMonth = person.created_local_date.slice(0, 7) > month;
    const firstEmployedDay = person.created_local_date.slice(0, 7) === month
      ? Number(person.created_local_date.slice(8, 10))
      : 1;

    for (let dayNumber = firstEmployedDay; !joinedAfterMonth && dayNumber <= daysToInclude; dayNumber += 1) {
      const date = `${month}-${String(dayNumber).padStart(2, "0")}`;
      const events = days.get(date);
      const arrival = events?.datang?.[0];
      const departures = events?.pulang ?? [];
      const firstEvent = arrival ?? departures[0];
      const schedule = firstEvent ? schedulesById.get(firstEvent.schedule_id) : null;
      if (firstEvent && !schedule) throw new Error(`Missing schedule for attendance by ${person.name}.`);
      if (firstEvent) summary.scheduleLabels.add(firstEvent.schedule_label ?? schedule.label);
      countArrival(arrival);
      if (departures.some(departure =>
        attendanceMinutes(departure.created_at) > timeToMinutes(departure.schedule_end_time))) {
        summary.lateDeparture += 1;
      }
    }

    if (isCurrentMonth && today >= person.created_local_date) {
      const todayEvents = days.get(today);
      const arrival = todayEvents?.datang?.[0];
      const firstEvent = arrival ?? todayEvents?.pulang?.[0];
      const schedule = firstEvent ? schedulesById.get(firstEvent.schedule_id) : null;
      if (firstEvent && !schedule) throw new Error(`Missing schedule for attendance by ${person.name}.`);
      if (firstEvent) summary.scheduleLabels.add(firstEvent.schedule_label ?? schedule.label);
      if (arrival) {
        countArrival(arrival);
      } else if (!firstEvent && nowMinutes >= latestShiftEnd) {
        summary.absent += 1;
      }
      if ((todayEvents?.pulang ?? []).some(departure =>
        attendanceMinutes(departure.created_at) > timeToMinutes(departure.schedule_end_time))) {
        summary.lateDeparture += 1;
      }
    }
    return { ...summary, scheduleLabels: [...summary.scheduleLabels] };
  });

  return {
    month,
    daysIncluded: Math.max(daysToInclude, 0) + (currentDayIncluded ? 1 : 0),
    daysPending: isCurrentMonth
      ? lastCalendarDay - Math.max(daysToInclude, 0) - (currentDayIncluded ? 1 : 0)
      : 0,
    currentDayIncluded,
    rules,
    schedules,
    employees
  };
}

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  return next();
});
app.use((request, response, next) => {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0 || !request.is("application/json")) {
    return next();
  }
  if (request.body.length > 128 * 1024) {
    return sendError(response, 413, "Ukuran data yang dikirim melebihi batas.");
  }
  try {
    request.body = JSON.parse(request.body.toString("utf8"));
    return next();
  } catch {
    return sendError(response, 400, "Data JSON tidak valid.");
  }
});
app.use(express.json({ limit: "128kb" }));

app.get("/api/form", async (_request, response) => {
  const database = getSupabase();
  const [people, fields, rules, schedulesRows] = await Promise.all([
    database.from("people").select("id,name").order("name"),
    database.from("custom_fields").select("id,label,type,options_json,required").order("id"),
    getAttendanceRules(),
    getAttendanceSchedules()
  ]);
  return response.json({
    people: unwrap(people).map(publicPerson),
    fields: unwrap(fields).map(publicField),
    rules,
    schedules: schedulesRows.map(publicSchedule)
  });
});

app.get("/api/attendance/shift", async (request, response) => {
  const name = typeof request.query.name === "string" ? request.query.name.trim() : "";
  if (!name || name.length > 80) return sendError(response, 400, "Pilih nama yang valid.");
  const person = unwrap(await getSupabase().from("people").select("name").eq("name", name).maybeSingle());
  if (!person) return sendError(response, 400, "Nama tidak ditemukan.");
  const record = unwrap(await getSupabase().from("attendance")
    .select("schedule_id")
    .eq("person_name", person.name)
    .eq("created_local_date", localDate())
    .order("created_at")
    .limit(1)
    .maybeSingle());
  return response.json({ scheduleId: record?.schedule_id ?? null });
});

app.get("/api/admin/status", async (_request, response) => {
  return response.json({ configured: await hasAdmin() });
});

app.post("/api/attendance", limitAttendanceRequest, upload.single("photo"), async (request, response) => {
  if (!request.is("multipart/form-data")) return sendError(response, 400, "Kirim data dalam format formulir.");
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const note = typeof request.body.note === "string" ? request.body.note.trim() : "";
  const attendanceType = request.body.attendanceType;
  const scheduleId = typeof request.body.scheduleId === "string" ? request.body.scheduleId : "";
  if (name.length === 0 || name.length > 80) return sendError(response, 400, "Pilih nama yang valid.");
  if (note.length > 2000) return sendError(response, 400, "Keterangan maksimal 2.000 karakter.");
  if (attendanceType !== "datang" && attendanceType !== "pulang") {
    return sendError(response, 400, "Pilih jenis absensi: Datang atau Pulang.");
  }
  if (!scheduleId) return sendError(response, 400, "Pilih jadwal kerja hari ini.");

  let values;
  try {
    values = JSON.parse(request.body.values ?? "{}");
    if (!values || Array.isArray(values) || typeof values !== "object") throw new Error();
  } catch {
    return sendError(response, 400, "Data kolom tambahan tidak valid.");
  }
  const database = getSupabase();
  const fields = unwrap(await database.from("custom_fields")
    .select("id,label,type,options_json,required")
    .order("id")).map(publicField);
  const fieldsById = new Map(fields.map(field => [String(field.id), field]));
  const savedValues = {};
  for (const field of fields) {
    const value = values[String(field.id)];
    const isMissing = value === undefined || value === null || value === "";
    if (field.required && (isMissing || (field.type === "checkbox" && value !== "true"))) {
      return sendError(response, 400, `Kolom “${field.label}” wajib diisi.`);
    }
  }
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldsById.get(fieldId);
    if (!field) return sendError(response, 400, "Kolom absensi telah berubah. Muat ulang formulir.");
    if (typeof value !== "string" || value.length > 4000) {
      return sendError(response, 400, "Isi kolom tambahan terlalu panjang atau tidak valid.");
    }
    if (field.type === "select" && !field.options.includes(value)) {
      return sendError(response, 400, `Pilihan untuk kolom “${field.label}” tidak valid.`);
    }
    if (field.type === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
      return sendError(response, 400, `Isi kolom “${field.label}” harus berupa angka.`);
    }
    if (field.type === "date" && !isValidDate(value)) {
      return sendError(response, 400, `Isi kolom “${field.label}” harus berupa tanggal yang valid.`);
    }
    if (field.type === "checkbox" && value !== "true" && value !== "false") {
      return sendError(response, 400, `Isi kolom “${field.label}” tidak valid.`);
    }
    if (value.length > 0) savedValues[field.label] = value;
  }

  const personResult = await database.from("people")
    .select("id,name")
    .eq("name", name)
    .maybeSingle();
  const person = unwrap(personResult);
  if (!person) return sendError(response, 400, "Nama tidak ditemukan. Muat ulang formulir dan pilih nama yang tersedia.");
  const scheduleRow = unwrap(await database.from("attendance_schedules")
    .select("id,label,start_time,end_time")
    .eq("id", scheduleId)
    .maybeSingle());
  if (!scheduleRow) return sendError(response, 400, "Pilih kategori jadwal yang valid.");
  const schedule = publicSchedule(scheduleRow);
  if (!request.file) return sendError(response, 400, "Foto wajib diunggah.");
  const photoContentType = request.file.mimetype.toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(photoContentType) ||
      !hasValidImageSignature(request.file.buffer, photoContentType)) {
    return sendError(response, 400, "Gunakan foto JPG, PNG, atau WebP dengan format file yang valid.");
  }

  const today = localDate();
  const existing = await database.from("attendance")
    .select("id,attendance_type,schedule_id")
    .eq("person_name", person.name)
    .eq("created_local_date", today)
    .order("created_at");
  const existingRows = unwrap(existing);
  if (existingRows.some(record => record.schedule_id !== scheduleId)) {
    return sendError(response, 409, `Shift hari ini sudah dikunci sebagai ${publicSchedule(unwrap(await database.from("attendance_schedules")
      .select("id,label,start_time,end_time").eq("id", existingRows[0].schedule_id).single())).label}. Gunakan shift yang sama.`);
  }
  if (existingRows.some(record => record.attendance_type === attendanceType)) {
    return sendError(response, 409, `Absensi ${attendanceType} sudah tercatat untuk nama ini hari ini.`);
  }

  const rules = await getAttendanceRules();
  const photoPath = `${today}/${crypto.randomUUID()}.${photoContentType.split("/")[1]}`;
  unwrap(await database.storage.from(PHOTO_BUCKET).upload(photoPath, request.file.buffer, {
    contentType: photoContentType,
    upsert: false
  }));

  const createdAt = new Date().toISOString();
  const minutesLate = attendanceMinutes(createdAt) - timeToMinutes(schedule.startTime);
  const inserted = await database.from("attendance").insert({
    person_name: person.name,
    attendance_type: attendanceType,
    note,
    values_json: savedValues,
    photo_path: photoPath,
    photo_content_type: photoContentType,
    created_at: createdAt,
    created_local_date: today,
    schedule_id: scheduleId,
    schedule_label: schedule.label,
    schedule_start_time: schedule.startTime,
    schedule_end_time: schedule.endTime
  }).select("id").single();
  if (inserted.error) {
    const cleanup = await database.storage.from(PHOTO_BUCKET).remove([photoPath]);
    if (cleanup.error) console.error("Failed to clean up unattached attendance photo:", cleanup.error);
    if (inserted.error.code === "23505") {
      return sendError(response, 409, `Absensi ${attendanceType} sudah tercatat untuk nama ini hari ini.`);
    }
    if (inserted.error.code === "23514") {
      return sendError(response, 409, "Shift hari ini sudah dikunci oleh absensi lain. Muat ulang formulir dan gunakan shift yang sama.");
    }
    throw inserted.error;
  }

  let message = `Absensi ${attendanceType} berhasil disimpan.`;
  if (attendanceType === "datang" && minutesLate > rules.lateLimitMinutes) {
    message = "Absensi datang tercatat, tetapi melewati batas keterlambatan dan dihitung tidak masuk.";
  } else if (attendanceType === "datang" && minutesLate > rules.toleranceMinutes) {
    message = "Absensi datang tercatat sebagai terlambat.";
  } else if (attendanceType === "pulang" && attendanceMinutes(createdAt) > timeToMinutes(schedule.endTime)) {
    message = "Absensi pulang tercatat terlambat.";
  }
  return response.json({ id: inserted.data.id, message });
});

app.post("/api/admin/setup", limitAdminAuthentication, async (request, response) => {
  if (await hasAdmin()) return sendError(response, 409, "Akun admin sudah dibuat. Silakan masuk.");
  const validation = validateCredentials(request.body?.username, request.body?.password);
  if (validation) return sendError(response, 400, validation);

  const username = request.body.username.trim();
  const salt = crypto.randomBytes(16);
  const passwordHash = await derivePasswordHash(request.body.password, salt);
  const inserted = await getSupabase().from("admins").insert({
    id: 1,
    username,
    salt: salt.toString("hex"),
    password_hash: passwordHash.toString("hex"),
    password_scheme: "scrypt"
  });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Akun admin sudah dibuat atau username sudah digunakan.");
  unwrap(inserted);
  setAdminCookie(request, response, username, passwordHash.toString("hex"));
  return response.json({ message: "Akun admin berhasil dibuat." });
});

app.post("/api/admin/login", limitAdminAuthentication, async (request, response) => {
  const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const admins = unwrap(await getSupabase().from("admins").select("username,salt,password_hash,password_scheme"));
  const admin = admins.find(candidate => candidate.username.toLowerCase() === username.toLowerCase());
  if (!admin || password.length > 200) return response.status(401).json({ error: "Username atau kata sandi salah." });
  const passwordHash = await verifyPasswordHash(password, Buffer.from(admin.salt, "hex"), admin.password_scheme);
  const expectedHash = Buffer.from(admin.password_hash, "hex");
  if (passwordHash.length !== expectedHash.length || !crypto.timingSafeEqual(passwordHash, expectedHash)) {
    return response.status(401).json({ error: "Username atau kata sandi salah." });
  }
  setAdminCookie(request, response, admin.username, admin.password_hash);
  return response.json({ message: "Berhasil masuk." });
});

const admin = express.Router();
admin.use(requireAdmin);

admin.post("/logout", (request, response) => {
  clearAdminCookie(request, response);
  return response.json({ message: "Anda telah keluar." });
});

admin.get("/data", async (_request, response) => response.json(await dashboardData()));

admin.get("/records", async (request, response) => {
  const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    return sendError(response, 400, "Posisi riwayat tidak valid.");
  }
  if (request.query.name !== undefined && typeof request.query.name !== "string") {
    return sendError(response, 400, "Nama filter tidak valid.");
  }
  if (request.query.date !== undefined && typeof request.query.date !== "string") {
    return sendError(response, 400, "Tanggal filter tidak valid.");
  }
  const name = typeof request.query.name === "string" ? request.query.name.trim() : "";
  const date = typeof request.query.date === "string" ? request.query.date : "";
  if (name.length > 80) return sendError(response, 400, "Nama filter tidak valid.");
  if (date && !isValidDate(date)) return sendError(response, 400, "Tanggal filter tidak valid.");
  const pageSize = 25;
  const database = getSupabase();
  let recordsQuery = database.from("attendance")
    .select("id,person_name,attendance_type,note,values_json,photo_path,created_at,schedule_id,schedule_label,schedule_start_time,schedule_end_time")
    .order("id", { ascending: false });
  if (name) recordsQuery = recordsQuery.eq("person_name", name);
  if (date) recordsQuery = recordsQuery.eq("created_local_date", date);
  const [rows, schedulesRows] = await Promise.all([
    recordsQuery.range(offset, offset + pageSize),
    getAttendanceSchedules()
  ]);
  const schedulesById = new Map(schedulesRows.map(schedule => [schedule.id, schedule]));
  const result = unwrap(rows);
  const records = result.slice(0, pageSize).map(record => ({
    id: record.id,
    name: record.person_name,
    type: record.attendance_type,
    note: record.note,
    values: record.values_json,
    hasPhoto: Boolean(record.photo_path),
    createdAt: record.created_at,
    scheduleLabel: record.schedule_label ?? schedulesById.get(record.schedule_id)?.label ?? "Jadwal tidak diketahui",
    scheduleStartTime: record.schedule_start_time,
    scheduleEndTime: record.schedule_end_time
  }));
  return response.json({ records, hasMore: result.length > pageSize });
});

admin.get("/schedules", async (_request, response) => {
  return response.json({ schedules: (await getAttendanceSchedules()).map(publicSchedule) });
});

admin.get("/summary", async (request, response) => {
  const month = request.query.month;
  const currentMonth = localDate().slice(0, 7);
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return sendError(response, 400, "Pilih bulan rekap yang valid.");
  }
  if (month > currentMonth) return sendError(response, 400, "Rekap untuk bulan mendatang belum tersedia.");
  return response.json(await monthlyAttendanceSummary(month));
});

admin.post("/rules", async (request, response) => {
  const { toleranceMinutes, lateLimitMinutes, earlyLimitMinutes } = request.body ?? {};
  if (!Number.isInteger(toleranceMinutes) || toleranceMinutes < 0 || toleranceMinutes > 180) {
    return sendError(response, 400, "Toleransi keterlambatan harus antara 0 dan 180 menit.");
  }
  if (!Number.isInteger(earlyLimitMinutes) || earlyLimitMinutes < 0 || earlyLimitMinutes > 360) {
    return sendError(response, 400, "Batas datang awal harus antara 0 dan 360 menit.");
  }
  if (!Number.isInteger(lateLimitMinutes) || lateLimitMinutes < 1 ||
      lateLimitMinutes > 360 || lateLimitMinutes <= toleranceMinutes) {
    return sendError(response, 400, "Batas terlambat harus lebih besar daripada toleransi dan maksimal 360 menit.");
  }
  unwrap(await getSupabase().from("attendance_rules").update({
    tolerance_minutes: toleranceMinutes,
    late_limit_minutes: lateLimitMinutes,
    early_limit_minutes: earlyLimitMinutes
  }).eq("id", 1));
  return response.json({ message: "Aturan absensi berhasil disimpan.", rules: await getAttendanceRules() });
});

admin.put("/schedules/:id", async (request, response) => {
  const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
  const { startTime, endTime } = request.body ?? {};
  if (!label || label.length > 60) {
    return sendError(response, 400, "Nama kategori wajib diisi (maksimal 60 karakter).");
  }
  const validTime = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime) || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    return sendError(response, 400, "Jam pulang harus lebih akhir daripada jam masuk pada hari yang sama.");
  }
  const schedules = await getAttendanceSchedules();
  if (schedules.some(schedule => schedule.id !== request.params.id &&
      schedule.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama kategori tersebut sudah digunakan.");
  }
  const updated = await getSupabase().from("attendance_schedules").update({
    label,
    start_time: startTime,
    end_time: endTime
  }).eq("id", request.params.id).select("id,label,start_time,end_time");
  if (updated.error?.code === "23505") return sendError(response, 409, "Nama kategori tersebut sudah digunakan.");
  const updatedRows = unwrap(updated);
  if (!updatedRows.length) return sendError(response, 404, "Kategori jadwal tidak ditemukan.");
  return response.json({
    message: `Jadwal ${updatedRows[0].label} berhasil disimpan.`,
    schedule: publicSchedule(updatedRows[0])
  });
});

admin.post("/schedules", async (request, response) => {
  const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
  const { startTime, endTime } = request.body ?? {};
  if (!label || label.length > 60) {
    return sendError(response, 400, "Nama kategori wajib diisi (maksimal 60 karakter).");
  }
  const validTime = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(startTime) || !validTime(endTime) || timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    return sendError(response, 400, "Jam pulang harus lebih akhir daripada jam masuk pada hari yang sama.");
  }
  const schedules = await getAttendanceSchedules();
  if (schedules.some(schedule => schedule.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama kategori tersebut sudah digunakan.");
  }
  const inserted = await getSupabase().from("attendance_schedules").insert({
    id: `custom-${crypto.randomUUID()}`,
    label,
    start_time: startTime,
    end_time: endTime
  }).select("id,label,start_time,end_time").single();
  if (inserted.error?.code === "23505") return sendError(response, 409, "Nama kategori tersebut sudah digunakan.");
  unwrap(inserted);
  return response.json({
    message: `Kategori ${inserted.data.label} berhasil ditambahkan.`,
    schedule: publicSchedule(inserted.data)
  });
});

admin.delete("/schedules/:id", async (request, response) => {
  const database = getSupabase();
  const schedule = unwrap(await database.from("attendance_schedules")
    .select("id,label")
    .eq("id", request.params.id)
    .maybeSingle());
  if (!schedule) return sendError(response, 404, "Kategori jadwal tidak ditemukan.");
  const schedules = await getAttendanceSchedules();
  if (schedules.length <= 1) return sendError(response, 409, "Minimal harus ada satu kategori jadwal.");
  const usage = await database.from("attendance")
    .select("id", { count: "exact", head: true })
    .eq("schedule_id", schedule.id);
  unwrap(usage);
  if (usage.count > 0) {
    return sendError(response, 409, "Kategori ini sudah digunakan dalam riwayat absensi sehingga tidak dapat dihapus.");
  }
  const deleted = await database.from("attendance_schedules")
    .delete()
    .eq("id", schedule.id)
    .select("id");
  if (deleted.error?.code === "23503") {
    return sendError(response, 409, "Kategori ini baru saja digunakan dalam absensi sehingga tidak dapat dihapus.");
  }
  if (!unwrap(deleted).length) return sendError(response, 404, "Kategori jadwal tidak ditemukan.");
  return response.json({ message: `Kategori ${schedule.label} berhasil dihapus.` });
});

admin.post("/people", async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  if (name.length === 0 || name.length > 80) {
    return sendError(response, 400, "Nama wajib diisi (maksimal 80 karakter).");
  }
  const existingPeople = unwrap(await getSupabase().from("people").select("name"));
  if (existingPeople.some(person => person.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama tersebut sudah ada.");
  }
  const inserted = await getSupabase().from("people").insert({
    name,
    created_local_date: localDate()
  });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Nama tersebut sudah ada.");
  unwrap(inserted);
  return response.json({ message: "Nama berhasil ditambahkan." });
});

admin.delete("/people/:id", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return sendError(response, 404, "Nama tidak ditemukan.");
  const deleted = unwrap(await getSupabase().from("people").delete().eq("id", id).select("id"));
  if (!deleted.length) return sendError(response, 404, "Nama tidak ditemukan.");
  return response.json({ message: "Nama berhasil dihapus." });
});

admin.post("/fields", async (request, response) => {
  const label = typeof request.body?.label === "string" ? request.body.label.trim() : "";
  const type = typeof request.body?.type === "string" ? request.body.type.trim().toLowerCase() : "";
  const required = request.body?.required === true;
  if (label.length === 0 || label.length > 60) {
    return sendError(response, 400, "Nama kolom wajib diisi (maksimal 60 karakter).");
  }
  if (!["text", "number", "date", "select", "checkbox"].includes(type)) {
    return sendError(response, 400, "Tipe kolom tidak didukung.");
  }
  let options = [];
  if (type === "select") {
    const rawOptions = typeof request.body.options === "string" ? request.body.options : "";
    options = [...new Map(rawOptions.split(",").map(option => option.trim()).filter(Boolean)
      .map(option => [option.toLowerCase(), option])).values()];
    if (options.length < 2 || options.some(option => option.length > 60)) {
      return sendError(response, 400, "Kolom pilihan memerlukan minimal dua opsi (pisahkan dengan koma).");
    }
  }
  const existingFields = unwrap(await getSupabase().from("custom_fields").select("label"));
  if (existingFields.some(field => field.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    return sendError(response, 409, "Nama kolom tersebut sudah ada.");
  }
  const inserted = await getSupabase().from("custom_fields").insert({
    label,
    type,
    options_json: options,
    required
  });
  if (inserted.error?.code === "23505") return sendError(response, 409, "Nama kolom tersebut sudah ada.");
  unwrap(inserted);
  return response.json({ message: "Kolom berhasil ditambahkan." });
});

admin.delete("/fields/:id", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return sendError(response, 404, "Kolom tidak ditemukan.");
  const deleted = unwrap(await getSupabase().from("custom_fields").delete().eq("id", id).select("id"));
  if (!deleted.length) return sendError(response, 404, "Kolom tidak ditemukan.");
  return response.json({ message: "Kolom berhasil dihapus." });
});

admin.post("/password", async (request, response) => {
  const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
  const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
  if (newPassword.length < 12 || newPassword.length > 200) {
    return sendError(response, 400, "Kata sandi baru harus terdiri dari minimal 12 karakter.");
  }
  const adminRow = unwrap(await getSupabase().from("admins")
    .select("username,salt,password_hash,password_scheme")
    .eq("id", 1)
    .maybeSingle());
  if (!adminRow || adminRow.username.toLowerCase() !== request.adminUsername.toLowerCase()) {
    return sendError(response, 400, "Kata sandi saat ini salah.");
  }
  const currentHash = await verifyPasswordHash(currentPassword, Buffer.from(adminRow.salt, "hex"), adminRow.password_scheme);
  const expectedHash = Buffer.from(adminRow.password_hash, "hex");
  if (currentHash.length !== expectedHash.length || !crypto.timingSafeEqual(currentHash, expectedHash)) {
    return sendError(response, 400, "Kata sandi saat ini salah.");
  }

  const salt = crypto.randomBytes(16);
  const passwordHash = await derivePasswordHash(newPassword, salt);
  unwrap(await getSupabase().from("admins").update({
    salt: salt.toString("hex"),
    password_hash: passwordHash.toString("hex"),
    password_scheme: "scrypt"
  }).eq("id", 1));
  clearAdminCookie(request, response);
  return response.json({ message: "Kata sandi berhasil diperbarui. Silakan masuk kembali." });
});

admin.get("/attendance/:id/photo", async (request, response) => {
  const id = Number.parseInt(request.params.id, 10);
  if (!Number.isSafeInteger(id) || id < 1) return response.sendStatus(404);
  const record = unwrap(await getSupabase().from("attendance")
    .select("photo_path,photo_content_type")
    .eq("id", id)
    .maybeSingle());
  if (!record || !record.photo_path ||
      !["image/jpeg", "image/png", "image/webp"].includes(record.photo_content_type)) {
    return response.sendStatus(404);
  }
  const signed = unwrap(await getSupabase().storage.from(PHOTO_BUCKET).createSignedUrl(record.photo_path, 60));
  return response.redirect(signed.signedUrl);
});

app.use("/api/admin", admin);
app.use("/api", (_request, response) => sendError(response, 404, "Endpoint tidak ditemukan."));
app.use(express.static(STATIC_DIRECTORY, { index: "index.html" }));

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Ukuran foto maksimal 3,5 MiB."
      : error.code === "LIMIT_FIELD_COUNT"
        ? "Jumlah data formulir melebihi batas."
        : "Batas formulir terlampaui. Periksa kembali data yang dikirim.";
    return sendError(response, 400, message);
  }
  if (error.type === "entity.too.large") return sendError(response, 413, "Ukuran data yang dikirim melebihi batas.");
  if (error.type === "entity.parse.failed") return sendError(response, 400, "Data JSON tidak valid.");
  console.error(error);
  return sendError(response, 500, "Terjadi kesalahan pada server.");
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Hadir berjalan di http://localhost:${PORT}`);
    console.log(`Zona waktu aplikasi: ${APP_TIME_ZONE}`);
  });
}

module.exports = app;
