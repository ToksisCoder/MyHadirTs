const $ = (selector, root = document) => root.querySelector(selector);
const attendanceView = $("#attendance-view");
const adminView = $("#admin-view");
const attendanceNav = $("#attendance-nav");
const adminNav = $("#admin-nav");
const toast = $("#toast");
let currentForm = { people: [], fields: [], rules: null, schedules: [] };
let lockedScheduleId = null;
let personShiftRequest = 0;
let cameraStream = null;
let cameraFacingMode = "environment";
let capturedPhoto = null;
let photoPreviewUrl = null;
let adminData = null;
let toastTimer;
let monthlyReportSequence = 0;
let recordsOffset = 0;
let recordsLoaded = false;
let recordsHasMore = false;
let recordsLoading = false;
let recordsRequestSequence = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { "Content-Type": "application/json", ...options.headers }
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || (response.status === 401 ? "Silakan masuk sebagai admin." : "Permintaan tidak berhasil."));
    error.status = response.status;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast${isError ? " toast-error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3600);
}

function setView(view) {
  const isAdmin = view === "admin";
  attendanceView.classList.toggle("hidden", isAdmin);
  adminView.classList.toggle("hidden", !isAdmin);
  attendanceNav.classList.toggle("active", !isAdmin);
  adminNav.classList.toggle("active", isAdmin);
  if (isAdmin) {
    window.location.hash = "admin";
    openAdmin();
  } else {
    window.history.replaceState(null, "", window.location.pathname);
    loadForm().catch(error => showToast(error.message, true));
  }
}

function renderCustomInput(field) {
  const id = `custom-${field.id}`;
  const requirement = field.required
    ? '<span class="required-star">*</span><span class="optional-label">Wajib diisi</span>'
    : '<span class="optional-label">Opsional</span>';
  const requiredAttribute = field.required ? " required" : "";
  const label = `<label class="field-label" for="${id}">${escapeHtml(field.label)} ${requirement}</label>`;
  if (field.type === "select") {
    const choices = field.options.map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
    return `${label}<div class="select-wrap"><select id="${id}" data-field-id="${field.id}"${requiredAttribute}><option value="">Pilih opsi</option>${choices}</select><span class="select-chevron" aria-hidden="true">⌄</span></div>`;
  }
  if (field.type === "checkbox") {
    return `<label class="checkbox-field custom-checkbox" for="${id}"><input id="${id}" type="checkbox" data-field-id="${field.id}"${requiredAttribute}><span>${escapeHtml(field.label)}</span>${field.required ? '<span class="checkbox-requirement">Wajib</span>' : ""}</label>`;
  }
  return `${label}<input id="${id}" type="${escapeHtml(field.type)}" data-field-id="${field.id}"${requiredAttribute} ${field.type === "number" ? 'step="any"' : ""} placeholder="${field.type === "text" ? "Isi " + escapeHtml(field.label.toLowerCase()) : ""}">`;
}

async function loadForm() {
  currentForm = await api("/api/form");
  const select = $("#person-select");
  select.innerHTML = `<option value="">Pilih namamu</option>${currentForm.people.map(person =>
    `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)}</option>`
  ).join("")}`;
  const scheduleSelect = $("#schedule-select");
  scheduleSelect.innerHTML = `<option value="">Pilih shift hari ini</option>${currentForm.schedules.map(schedule =>
    `<option value="${escapeHtml(schedule.id)}">${escapeHtml(schedule.label)} (${escapeHtml(schedule.startTime)}–${escapeHtml(schedule.endTime)})</option>`
  ).join("")}`;
  $("#custom-fields").innerHTML = currentForm.fields.map(renderCustomInput).join("");
  lockedScheduleId = null;
  await updateAttendanceScheduleHint();
  if (!currentForm.people.length) {
    select.disabled = true;
    select.innerHTML = `<option value="">Nama belum ditambahkan oleh admin</option>`;
    if (!$(".inline-hint")) {
      const hint = document.createElement("p");
      hint.className = "inline-hint";
      hint.innerHTML = 'Belum ada nama. Minta admin menambahkan nama lewat <button type="button" data-open-admin>panel admin</button>.';
      select.closest(".select-wrap").after(hint);
    }
  } else {
    select.disabled = false;
    $(".inline-hint")?.remove();
  }
}

async function updateAttendanceScheduleHint() {
  const selectedName = $("#person-select").value;
  const scheduleSelect = $("#schedule-select");
  const requestId = ++personShiftRequest;
  lockedScheduleId = null;
  scheduleSelect.disabled = false;
  scheduleSelect.value = "";
  if (!selectedName) {
    $("#attendance-rules-hint").textContent = `Pilih nama dan shift yang sedang dijalani hari ini. Kedatangan awal tetap diterima; lebih dari ${currentForm.rules.earlyLimitMinutes} menit sebelum jam masuk dihitung sebagai nilai plus.`;
    return;
  }
  try {
    const result = await api(`/api/attendance/shift?name=${encodeURIComponent(selectedName)}`);
    if (requestId !== personShiftRequest) return;
    lockedScheduleId = result.scheduleId;
  } catch (error) {
    if (requestId !== personShiftRequest) return;
    $("#attendance-rules-hint").textContent = error.message;
    return;
  }
  const schedule = currentForm.schedules.find(candidate => candidate.id === lockedScheduleId);
  if (lockedScheduleId && !schedule) {
    $("#attendance-rules-hint").textContent = "Shift absensi hari ini tidak ditemukan. Hubungi admin.";
    return;
  }
  if (schedule) {
    scheduleSelect.value = schedule.id;
    scheduleSelect.disabled = true;
  } else {
    scheduleSelect.value = "";
  }
  const tolerance = currentForm.rules.toleranceMinutes;
  $("#attendance-rules-hint").textContent = schedule
    ? `Shift hari ini terkunci: ${schedule.label} (${schedule.startTime}–${schedule.endTime}). Kedatangan awal tetap diterima; lebih dari ${currentForm.rules.earlyLimitMinutes} menit sebelum jam masuk dihitung sebagai nilai plus. Gunakan shift yang sama untuk absensi berikutnya.`
    : `Pilih shift yang sedang dijalani hari ini. Kedatangan awal tetap diterima; lebih dari ${currentForm.rules.earlyLimitMinutes} menit sebelum jam masuk dihitung sebagai nilai plus. Toleransi terlambat ${tolerance} menit.`;
}

function renderAuth(configured) {
  const title = configured ? "Masuk ke panel admin" : "Siapkan akun admin";
  const subtitle = configured
    ? "Pengaturan dan analisis hanya tersedia untuk admin."
    : "Buat akun admin pertama sebelum membagikan tautan absensi.";
  $("#admin-auth").innerHTML = `
    <section class="auth-card">
      <span class="step-label">AREA TERBATAS <span>ADMIN</span></span>
      <div class="auth-symbol" aria-hidden="true">⌑</div>
      <h1>${title}</h1>
      <p>${subtitle}</p>
      <form id="${configured ? "admin-login-form" : "admin-setup-form"}" class="stacked-form">
        <label class="field-label" for="admin-username">Username</label>
        <input id="admin-username" name="username" autocomplete="username" minlength="3" maxlength="40" required>
        <label class="field-label" for="admin-password">${configured ? "Kata sandi" : "Buat kata sandi"}</label>
        <input id="admin-password" name="password" type="password" autocomplete="${configured ? "current-password" : "new-password"}" ${configured ? "" : 'minlength="12"'} required>
        ${configured ? "" : '<p class="form-hint">Gunakan minimal 12 karakter. Simpan dengan aman; akun ini tidak memiliki fitur pemulihan otomatis.</p>'}
        <button class="button button-primary" type="submit">${configured ? "Masuk ke panel" : "Buat akun admin"} <span aria-hidden="true">→</span></button>
        <div class="auth-error" id="auth-error" role="alert"></div>
      </form>
    </section>`;
}

function renderAdminError(error) {
  $("#admin-auth").innerHTML = `
    <section class="auth-card">
      <span class="step-label">AREA TERBATAS <span>ADMIN</span></span>
      <div class="auth-symbol" aria-hidden="true">!</div>
      <h1>Panel admin belum dapat dimuat.</h1>
      <p>Periksa koneksi API Netlify, environment variables Supabase, dan apakah skema database sudah dijalankan.</p>
      <div class="auth-error" role="alert">${escapeHtml(error.message)}${error.status ? ` (HTTP ${error.status})` : ""}</div>
      <button class="button button-primary" data-retry-admin type="button">Coba lagi <span aria-hidden="true">→</span></button>
    </section>`;
}

async function openAdmin() {
  adminData = null;
  $("#admin-dashboard").classList.add("hidden");
  $("#admin-auth").classList.remove("hidden");
  try {
    const data = await api("/api/admin/data");
    adminData = data;
    renderDashboard(data);
    $("#admin-auth").classList.add("hidden");
    $("#admin-dashboard").classList.remove("hidden");
  } catch (error) {
    if (error.status !== 401) {
      renderAdminError(error);
      showToast(error.message, true);
      return;
    }
    try {
      const status = await api("/api/admin/status");
      renderAuth(status.configured);
    } catch (statusError) {
      renderAdminError(statusError);
      showToast(statusError.message, true);
    }
  }
}

function renderRecord(record) {
  const values = record.values || {};
  const custom = Object.entries(values).map(([label, value]) =>
    `<span class="record-extra"><b>${escapeHtml(label)}:</b> ${escapeHtml(value === "true" ? "Ya" : value === "false" ? "Tidak" : value)}</span>`
  ).join("");
  const photo = record.hasPhoto
    ? `<a class="photo-link" href="/api/admin/attendance/${record.id}/photo" target="_blank" rel="noopener">Lihat foto ↗</a>`
    : `<span class="muted-cell">—</span>`;
  const attendanceType = record.type === "pulang" ? "Pulang" : "Datang";
  return `<tr>
    <td><span class="record-date">${escapeHtml(formatDate(record.createdAt))}</span><span class="record-time">${escapeHtml(formatTime(record.createdAt))}</span></td>
    <td><strong>${escapeHtml(record.name)}</strong><span class="record-type">${attendanceType} · ${escapeHtml(record.scheduleLabel)} (${escapeHtml(record.scheduleStartTime)}–${escapeHtml(record.scheduleEndTime)})</span></td>
    <td><span class="record-note">${escapeHtml(record.note || "—")}</span>${custom}</td>
    <td>${photo}</td>
  </tr>`;
}

function renderDashboard(data) {
  recordsRequestSequence += 1;
  recordsOffset = 0;
  recordsLoaded = false;
  recordsHasMore = false;
  recordsLoading = false;
  const days = data.dailyCounts || [];
  const maxCount = Math.max(1, ...days.map(day => day.count));
  const fieldTypes = { text: "Teks", number: "Angka", date: "Tanggal", select: "Pilihan", checkbox: "Centang" };
  const currentMonth = data.today.slice(0, 7);
  const rules = data.rules;
  $("#admin-dashboard").innerHTML = `
    <div class="admin-heading">
      <div>
        <div class="eyebrow"><span class="live-dot"></span> RUANG ADMIN</div>
        <h1>Ringkasan absensi<span class="brand-period">.</span></h1>
        <p class="hero-copy">Pantau kehadiran dan kelola formulir dari satu tempat.</p>
      </div>
      <button class="button button-quiet" id="logout-button" type="button">Keluar <span aria-hidden="true">↗</span></button>
    </div>
    <div class="admin-tabs" role="tablist">
      <button class="admin-tab active" data-admin-tab="analysis" type="button">Analisis</button>
      <button class="admin-tab" data-admin-tab="settings" type="button">Pengaturan formulir</button>
    </div>
    <section id="analysis-panel" class="admin-panel">
      <div class="stats-grid">
        <article class="stat-card"><span>Total absensi</span><strong>${data.stats.total.toLocaleString("id-ID")}</strong><small>Semua waktu</small></article>
        <article class="stat-card stat-highlight"><span>Hari ini</span><strong>${data.stats.today.toLocaleString("id-ID")}</strong><small>Absensi masuk hari ini</small></article>
        <article class="stat-card"><span>7 hari terakhir</span><strong>${data.stats.lastSevenDays.toLocaleString("id-ID")}</strong><small>Termasuk hari ini</small></article>
      </div>
      <div class="analysis-grid">
        <section class="panel-card">
          <div class="panel-title"><div><span class="step-label">TREN KEHADIRAN</span><h2>7 hari terakhir</h2></div><span class="chart-unit">jumlah</span></div>
          <div class="bar-chart">${days.map(day => `<div class="bar-column"><span class="bar-value">${day.count}</span><div class="bar-track"><div class="bar-fill" style="height:${Math.max(4, day.count / maxCount * 100)}%"></div></div><span class="bar-label">${escapeHtml(formatShortDate(day.date))}</span></div>`).join("")}</div>
        </section>
        <section class="panel-card quick-info">
          <span class="step-label">FORMULIR AKTIF</span>
          <strong>${data.people.length} <span>nama</span></strong>
          <p>${data.fields.length} kolom tambahan tersedia di formulir absensi.</p>
          <button class="text-button" data-admin-tab="settings" type="button">Kelola formulir <span aria-hidden="true">→</span></button>
        </section>
      </div>
      <section class="panel-card monthly-report-card">
        <div class="panel-title monthly-report-heading">
          <div><span class="step-label">REKAP PER KARYAWAN</span><h2>Rekap kehadiran bulanan</h2></div>
          <label class="month-picker-label" for="summary-month">Pilih bulan<input id="summary-month" type="month" value="${currentMonth}" max="${currentMonth}" required></label>
        </div>
        <p id="monthly-report-note" class="settings-description">Ringkasan keterlambatan, kedatangan awal, pulang terlambat, dan hari tanpa kehadiran.</p>
        <div id="monthly-report-content" class="table-scroll"><p class="empty-cell">Memuat rekap bulanan…</p></div>
      </section>
      <section class="panel-card records-card">
        <div class="panel-title records-title"><div><span class="step-label">AKTIVITAS TERBARU</span><h2>Riwayat absensi</h2></div><span id="records-count" class="records-count">Belum dimuat</span></div>
        <div class="records-filters">
          <label class="records-filter-label" for="records-person-filter">Nama karyawan
            <select id="records-person-filter"><option value="">Semua karyawan</option>${data.people.map(person =>
              `<option value="${escapeHtml(person.name)}">${escapeHtml(person.name)}</option>`
            ).join("")}</select>
          </label>
          <label class="records-filter-label" for="records-date-filter">Tanggal
            <input id="records-date-filter" type="date">
          </label>
        </div>
        <div class="records-controls">
          <p id="records-feedback" class="form-hint" role="status" aria-live="polite">Riwayat hanya dimuat saat diminta.</p>
          <button id="load-records-button" class="button button-secondary" type="button">Muat riwayat</button>
        </div>
        <div class="table-scroll"><table><thead><tr><th>Waktu</th><th>Nama / jenis</th><th>Keterangan &amp; kolom</th><th>Foto</th></tr></thead>
          <tbody id="records-table-body"><tr><td colspan="4" class="empty-cell">Klik “Muat riwayat” untuk menampilkan catatan.</td></tr></tbody>
        </table></div>
      </section>
    </section>
    <section id="settings-panel" class="admin-panel hidden">
      <div class="settings-grid">
        <section class="panel-card settings-card rules-card">
            <div class="panel-title"><div><span class="step-label">BATAS DATANG &amp; KETERLAMBATAN</span><h2>Aturan absensi</h2></div><span class="settings-count">Berlaku untuk semua jadwal</span></div>
            <p class="settings-description">Batas datang awal, toleransi, dan batas terlambat berlaku pada semua kategori. Perubahan aturan menghitung ulang rekap bulan sebelumnya.</p>
          <form id="attendance-rules-form" class="rules-form">
              <label class="field-label" for="late-tolerance">Maksimal toleransi keterlambatan (menit)</label><input id="late-tolerance" name="toleranceMinutes" type="number" min="0" max="180" value="${rules.toleranceMinutes}" required>
              <label class="field-label" for="late-limit">Batas akhir terlambat (menit setelah jam masuk)</label><input id="late-limit" name="lateLimitMinutes" type="number" min="1" max="360" value="${rules.lateLimitMinutes}" required>
              <label class="field-label" for="early-limit">Ambang nilai plus datang awal (menit sebelum jam masuk)</label><input id="early-limit" name="earlyLimitMinutes" type="number" min="0" max="360" value="${rules.earlyLimitMinutes}" required>
              <p class="form-hint rules-explanation">Absensi Datang tetap diterima meski jauh lebih awal. Kedatangan yang lebih awal daripada ambang ini dihitung sebagai nilai plus; toleransi hingga batas akhir menentukan keterlambatan.</p>
              <button class="button button-primary" type="submit">Simpan aturan</button>
            </form>
          </section>
          <section class="panel-card settings-card schedules-card">
            <div class="panel-title"><div><span class="step-label">KATEGORI JADWAL</span><h2>Jam masuk dan pulang tiap kategori</h2></div><span class="settings-count">${data.schedules.length} kategori</span></div>
            <p class="settings-description">Ubah nama dan jam kategori, atau tambahkan kategori rolling shift baru. Setiap catatan menyimpan nama dan jam yang berlaku saat absensi dibuat. Kategori yang sudah digunakan pada riwayat tidak dapat dihapus.</p>
            <div class="schedule-editor-list">${data.schedules.map(schedule => `
              <form class="schedule-editor-form" data-schedule-id="${escapeHtml(schedule.id)}">
                <label class="schedule-name-field"><span>Nama kategori</span><input name="label" maxlength="60" value="${escapeHtml(schedule.label)}" required></label>
                <label class="schedule-time-field"><span>Masuk</span><input name="startTime" type="time" value="${escapeHtml(schedule.startTime)}" required></label>
                <label class="schedule-time-field"><span>Pulang</span><input name="endTime" type="time" value="${escapeHtml(schedule.endTime)}" required></label>
                <div class="schedule-editor-actions">
                  <button class="button button-secondary" type="submit">Simpan kategori</button>
                  <button class="button button-quiet" data-delete-schedule="${escapeHtml(schedule.id)}" type="button" aria-label="Hapus kategori ${escapeHtml(schedule.label)}">Hapus</button>
                </div>
              </form>`).join("")}
            </div>
            <form id="add-schedule-form" class="schedule-add-form">
              <label class="schedule-name-field"><span>Nama kategori baru</span><input name="label" maxlength="60" placeholder="Contoh: Shift Malam" required></label>
              <label class="schedule-time-field"><span>Masuk</span><input name="startTime" type="time" value="08:00" required></label>
              <label class="schedule-time-field"><span>Pulang</span><input name="endTime" type="time" value="17:00" required></label>
              <button class="button button-primary" type="submit">Tambah kategori</button>
            </form>
            <p class="form-hint schedule-delete-hint">Kategori yang sudah memiliki riwayat absensi tidak dapat dihapus.</p>
          </section>
          <section class="panel-card settings-card">
            <div class="panel-title"><div><span class="step-label">DAFTAR PILIHAN</span><h2>Nama peserta</h2></div><span class="settings-count">${data.people.length}</span></div>
            <p class="settings-description">Tambahkan nama yang boleh dipilih pada formulir absensi. Karyawan memilih shift yang sedang dijalani setiap hari.</p>
            <form id="add-person-form" class="employee-add-form">
              <input name="name" maxlength="80" placeholder="Contoh: Andi Saputra" required>
              <button class="button button-primary" type="submit">Tambah</button>
            </form>
            <ul class="manage-list employee-list">${data.people.length ? data.people.map(person => `<li class="employee-manage-row">
              <span><strong>${escapeHtml(person.name)}</strong></span>
              <button class="icon-button" data-delete-person="${person.id}" type="button" aria-label="Hapus ${escapeHtml(person.name)}">×</button>
            </li>`).join("") : '<li class="list-empty">Belum ada nama.</li>'}</ul>
          </section>
        <section class="panel-card settings-card">
          <div class="panel-title"><div><span class="step-label">SESUAIKAN FORM</span><h2>Kolom tambahan</h2></div><span class="settings-count">${data.fields.length}</span></div>
          <p class="settings-description">Tambahkan isian khusus seperti divisi, status, atau jam datang.</p>
          <form id="add-field-form" class="field-builder">
            <label class="field-label" for="field-label">Nama kolom</label><input id="field-label" name="label" maxlength="60" placeholder="Contoh: Divisi" required>
            <label class="field-label" for="field-type">Jenis input</label>
            <div class="select-wrap"><select id="field-type" name="type"><option value="text">Teks</option><option value="number">Angka</option><option value="date">Tanggal</option><option value="select">Dropdown pilihan</option><option value="checkbox">Centang</option></select><span class="select-chevron" aria-hidden="true">⌄</span></div>
            <div id="field-options-wrap" class="hidden"><label class="field-label" for="field-options">Pilihan dropdown</label><input id="field-options" name="options" placeholder="Hadir, Izin, Sakit"><span class="form-hint">Pisahkan setiap pilihan dengan koma.</span></div>
            <label class="checkbox-field setting-required" for="field-required"><input id="field-required" name="required" type="checkbox"><span>Wajib diisi oleh peserta</span></label>
            <button class="button button-primary" type="submit">Tambah kolom <span aria-hidden="true">+</span></button>
          </form>
          <ul class="manage-list field-list">${data.fields.length ? data.fields.map(field => `<li><span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(fieldTypes[field.type] || field.type)} · ${field.required ? "Wajib diisi" : "Opsional"}${field.type === "select" ? ` · ${field.options.map(escapeHtml).join(", ")}` : ""}</small></span><button class="icon-button" data-delete-field="${field.id}" type="button" aria-label="Hapus kolom ${escapeHtml(field.label)}">×</button></li>`).join("") : '<li class="list-empty">Belum ada kolom tambahan.</li>'}</ul>
        </section>
        <section class="panel-card settings-card password-card">
          <div><span class="step-label">KEAMANAN</span><h2>Ubah kata sandi admin</h2><p class="settings-description">Gunakan kata sandi baru minimal 12 karakter.</p></div>
          <form id="change-password-form" class="field-builder">
            <label class="field-label" for="current-password">Kata sandi saat ini</label><input id="current-password" name="currentPassword" type="password" autocomplete="current-password" required>
            <label class="field-label" for="new-password">Kata sandi baru</label><input id="new-password" name="newPassword" type="password" minlength="12" autocomplete="new-password" required>
            <button class="button button-secondary" type="submit">Perbarui kata sandi</button>
          </form>
        </section>
      </div>
    </section>`;
  $("#field-type").addEventListener("change", event => $("#field-options-wrap").classList.toggle("hidden", event.target.value !== "select"));
  $("#summary-month").addEventListener("change", event => loadMonthlyReport(event.target.value));
  loadMonthlyReport(currentMonth);
}

function formatDate(value) {
  return new Date(value).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
function formatTime(value) {
  return new Date(value).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}
function formatShortDate(value) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function formatMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

async function loadMonthlyReport(month) {
  const sequence = ++monthlyReportSequence;
  const content = $("#monthly-report-content");
  if (!content) return;
  content.innerHTML = '<p class="empty-cell">Memuat rekap bulanan…</p>';
  try {
    const report = await api(`/api/admin/summary?month=${encodeURIComponent(month)}`);
    if (sequence !== monthlyReportSequence || !$("#monthly-report-content")) return;
    const pendingNote = report.daysPending
      ? report.currentDayIncluded
        ? ` · ${report.daysPending} hari tersisa di bulan ini belum direkap`
        : ` · hari ini menunggu jam pulang sesuai jadwal masing-masing, ${report.daysPending} hari belum direkap`
      : "";
    const note = `Rekap ${formatMonth(report.month)} · ${report.daysIncluded} hari kalender selesai dihitung${pendingNote}. Masuk menghitung hari dengan absensi Datang yang tidak melewati batas keterlambatan; tidak masuk mencakup hari tanpa absensi Datang atau Datang melewati batas tersebut.`;
    $("#monthly-report-note").textContent = note;
    content.innerHTML = `
      <table class="monthly-table">
        <thead><tr><th>Nama karyawan</th><th>Shift digunakan</th><th>Masuk</th><th>Terlambat</th><th>Masuk awal</th><th>Nilai plus (&gt;${report.rules.earlyLimitMinutes} menit awal)</th><th>Pulang terlambat</th><th>Tidak masuk / libur</th></tr></thead>
        <tbody>${report.employees.length ? report.employees.map(employee => `<tr>
          <td><strong>${escapeHtml(employee.name)}</strong></td><td>${employee.scheduleLabels.map(escapeHtml).join(", ") || "—"}</td>
          <td>${employee.present}</td><td>${employee.late}</td><td>${employee.early}</td><td>${employee.earlyBonus}</td><td>${employee.lateDeparture}</td><td>${employee.absent}</td>
        </tr>`).join("") : '<tr><td colspan="8" class="empty-cell">Belum ada nama karyawan.</td></tr>'}</tbody>
      </table>`;
  } catch (error) {
    if (sequence !== monthlyReportSequence || !$("#monthly-report-content")) return;
    content.innerHTML = `<p class="empty-cell">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAttendanceRecords() {
  if (recordsLoading || !recordsHasMore && recordsLoaded) return;
  const button = $("#load-records-button");
  const feedback = $("#records-feedback");
  const tableBody = $("#records-table-body");
  const requestSequence = recordsRequestSequence;
  recordsLoading = true;
  button.disabled = true;
  button.textContent = "Memuat…";
  feedback.textContent = "Memuat 25 catatan riwayat…";
  try {
    const params = new URLSearchParams({ offset: String(recordsOffset) });
    const name = $("#records-person-filter").value;
    const date = $("#records-date-filter").value;
    if (name) params.set("name", name);
    if (date) params.set("date", date);
    const result = await api(`/api/admin/records?${params}`);
    if (requestSequence !== recordsRequestSequence) return;
    if (result.records.length) {
      const emptyRow = tableBody.querySelector(".empty-cell");
      if (emptyRow) tableBody.replaceChildren();
      tableBody.insertAdjacentHTML("beforeend", result.records.map(renderRecord).join(""));
    } else if (!recordsLoaded) {
      tableBody.innerHTML = '<tr><td colspan="4" class="empty-cell">Belum ada data absensi.</td></tr>';
    }
    recordsOffset += result.records.length;
    recordsLoaded = true;
    recordsHasMore = result.hasMore;
    $("#records-count").textContent = `${recordsOffset} dimuat`;
    feedback.textContent = recordsHasMore
      ? "Tampilkan 25 catatan berikutnya jika diperlukan."
      : "Semua catatan riwayat telah dimuat.";
  } catch (error) {
    if (requestSequence !== recordsRequestSequence) return;
    feedback.textContent = `Riwayat gagal dimuat: ${error.message}`;
    showToast(error.message, true);
  } finally {
    if (requestSequence !== recordsRequestSequence) return;
    recordsLoading = false;
    button.disabled = false;
    button.textContent = recordsHasMore ? "Muat 25 berikutnya" : recordsLoaded ? "Riwayat selesai" : "Coba lagi";
    button.disabled = recordsLoaded && !recordsHasMore;
  }
}

async function refreshDashboard() {
  adminData = await api("/api/admin/data");
  renderDashboard(adminData);
  setAdminTab("settings");
}

function setAdminTab(tab) {
  document.querySelectorAll("#admin-dashboard .admin-tab").forEach(button => button.classList.toggle("active", button.dataset.adminTab === tab));
  $("#analysis-panel").classList.toggle("hidden", tab !== "analysis");
  $("#settings-panel").classList.toggle("hidden", tab !== "settings");
}

attendanceNav.addEventListener("click", () => setView("attendance"));
adminNav.addEventListener("click", () => setView("admin"));
$("#person-select").addEventListener("change", () => updateAttendanceScheduleHint());
document.addEventListener("change", event => {
  if (!event.target.matches("#records-person-filter, #records-date-filter")) return;
  recordsRequestSequence += 1;
  recordsOffset = 0;
  recordsLoaded = false;
  recordsHasMore = false;
  recordsLoading = false;
  $("#records-count").textContent = "Belum dimuat";
  $("#records-feedback").textContent = "Filter diperbarui. Klik “Muat riwayat” untuk menampilkan catatan.";
  $("#records-table-body").innerHTML = '<tr><td colspan="4" class="empty-cell">Klik “Muat riwayat” untuk menampilkan catatan.</td></tr>';
  const button = $("#load-records-button");
  button.disabled = false;
  button.textContent = "Muat riwayat";
});
$("#today-date").textContent = new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });

$("#attendance-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $(".submit-button", form);
  const feedback = $("#attendance-feedback");
  if (!capturedPhoto) {
    feedback.textContent = "Ambil foto menggunakan kamera sebelum mengirim absensi.";
    feedback.className = "feedback feedback-error";
    $("#camera-start").focus();
    return;
  }
  const values = {};
  for (const field of currentForm.fields) {
    const input = $(`[data-field-id="${field.id}"]`, form);
    if (field.type === "checkbox") values[field.id] = input.checked ? "true" : "false";
    else if (input.value) values[field.id] = input.value;
  }
  const body = new FormData();
  body.append("name", $("#person-select").value);
  body.append("scheduleId", lockedScheduleId || $("#schedule-select").value);
  body.append("attendanceType", $("#attendance-type").value);
  body.append("note", $("#attendance-note").value);
  body.append("values", JSON.stringify(values));
  body.append("photo", capturedPhoto);
  submit.disabled = true;
  feedback.className = "feedback hidden";
  try {
    const result = await api("/api/attendance", { method: "POST", body });
    form.reset();
    clearCapturedPhoto();
    await updateAttendanceScheduleHint();
    feedback.textContent = result.message;
    feedback.className = "feedback feedback-success";
  } catch (error) {
    if (error.status === 409) await updateAttendanceScheduleHint();
    feedback.textContent = error.message;
    feedback.className = "feedback feedback-error";
  } finally {
    submit.disabled = false;
  }
});

function stopCamera() {
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  $("#camera-video").srcObject = null;
  $("#camera-video").classList.add("hidden");
  $("#camera-capture").classList.add("hidden");
  $("#camera-capture").disabled = true;
  $("#camera-switch").classList.add("hidden");
}

function clearCapturedPhoto() {
  stopCamera();
  capturedPhoto = null;
  $("#camera-start").classList.remove("hidden");
  $("#camera-retake").classList.add("hidden");
  $("#photo-preview").classList.add("hidden");
  $("#photo-preview").removeAttribute("src");
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = null;
  $("#camera-hint").textContent = "Ambil foto langsung dengan kamera perangkat. Izin kamera diperlukan.";
}

$("#camera-start").addEventListener("click", async () => {
  const hint = $("#camera-hint");
  if (!navigator.mediaDevices?.getUserMedia) {
    hint.textContent = "Browser tidak mendukung akses kamera. Buka situs melalui HTTPS di browser terbaru.";
    return;
  }
  $("#camera-start").disabled = true;
  hint.textContent = "Meminta izin kamera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: cameraFacingMode } }
    });
    cameraStream = stream;
    const video = $("#camera-video");
    video.srcObject = cameraStream;
    await video.play();
    video.classList.remove("hidden");
    video.classList.toggle("camera-mirrored", cameraFacingMode === "user");
    $("#camera-start").classList.add("hidden");
    $("#camera-capture").classList.remove("hidden");
    $("#camera-capture").disabled = false;
    $("#camera-switch").textContent = cameraFacingMode === "environment"
      ? "Gunakan kamera depan"
      : "Gunakan kamera belakang";
    $("#camera-switch").classList.remove("hidden");
    hint.textContent = `Kamera ${cameraFacingMode === "environment" ? "belakang" : "depan"} aktif. Arahkan kamera, lalu ambil foto.`;
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "Izin kamera ditolak. Izinkan akses kamera pada pengaturan browser lalu coba lagi."
      : error.name === "NotFoundError"
        ? "Kamera tidak ditemukan pada perangkat ini."
        : error.name === "NotReadableError"
          ? "Kamera sedang digunakan aplikasi lain. Tutup aplikasi tersebut lalu coba lagi."
          : "Kamera tidak dapat dibuka. Pastikan situs menggunakan HTTPS dan izin kamera diaktifkan.";
    stopCamera();
    $("#camera-start").classList.remove("hidden");
    hint.textContent = message;
  } finally {
    $("#camera-start").disabled = false;
  }
});

$("#camera-switch").addEventListener("click", async () => {
  const hint = $("#camera-hint");
  const previousFacingMode = cameraFacingMode;
  const nextFacingMode = previousFacingMode === "environment" ? "user" : "environment";
  $("#camera-switch").disabled = true;
  $("#camera-capture").disabled = true;
  hint.textContent = "Mengganti kamera…";
  stopCamera();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: nextFacingMode } }
    });
    cameraFacingMode = nextFacingMode;
    const video = $("#camera-video");
    video.srcObject = cameraStream;
    await video.play();
    video.classList.remove("hidden");
    video.classList.toggle("camera-mirrored", cameraFacingMode === "user");
    $("#camera-start").classList.add("hidden");
    $("#camera-capture").classList.remove("hidden");
    $("#camera-capture").disabled = false;
    $("#camera-switch").textContent = cameraFacingMode === "environment"
      ? "Gunakan kamera depan"
      : "Gunakan kamera belakang";
    $("#camera-switch").classList.remove("hidden");
    hint.textContent = `Kamera ${cameraFacingMode === "environment" ? "belakang" : "depan"} aktif. Arahkan kamera, lalu ambil foto.`;
  } catch (error) {
    const message = error.name === "NotAllowedError"
      ? "Izin untuk mengganti kamera ditolak. Periksa izin kamera browser."
      : error.name === "NotFoundError"
        ? `Kamera ${nextFacingMode === "user" ? "depan" : "belakang"} tidak ditemukan pada perangkat ini.`
        : "Kamera tidak dapat diganti. Coba buka kamera kembali.";
    stopCamera();
    $("#camera-start").classList.remove("hidden");
    hint.textContent = message;
  } finally {
    $("#camera-switch").disabled = false;
  }
});

$("#camera-capture").addEventListener("click", async () => {
  const video = $("#camera-video");
  if (!cameraStream || !video.videoWidth || !video.videoHeight) {
    $("#camera-hint").textContent = "Kamera belum siap. Tunggu sebentar lalu coba lagi.";
    return;
  }
  const maxFileSize = 3.5 * 1024 * 1024;
  let scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
  let blob;
  try {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (cameraFacingMode === "user") {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88 - Math.min(attempt, 4) * 0.1));
      if (!blob) throw new Error("Foto tidak dapat diproses. Coba ambil ulang.");
      if (blob.size <= maxFileSize) break;
      scale *= 0.8;
    }
    if (!blob || blob.size > maxFileSize) throw new Error("Ukuran foto masih terlalu besar. Coba ambil ulang.");
    capturedPhoto = new File([blob], `absensi-${Date.now()}.jpg`, { type: "image/jpeg" });
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(capturedPhoto);
    $("#photo-preview").src = photoPreviewUrl;
    $("#photo-preview").classList.remove("hidden");
    stopCamera();
    $("#camera-start").classList.add("hidden");
    $("#camera-retake").classList.remove("hidden");
    $("#camera-hint").textContent = "Foto siap dikirim. Ambil ulang jika hasilnya belum sesuai.";
  } catch (error) {
    $("#camera-hint").textContent = error.message;
  }
});

$("#camera-retake").addEventListener("click", () => {
  clearCapturedPhoto();
  $("#camera-start").click();
});

document.addEventListener("click", async event => {
  const adminLink = event.target.closest("[data-open-admin]");
  if (adminLink) return setView("admin");
  if (event.target.closest("[data-retry-admin]")) return openAdmin();
  const tab = event.target.closest("[data-admin-tab]");
  if (tab && adminData) return setAdminTab(tab.dataset.adminTab);
  if (event.target.closest("#logout-button")) {
    try {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      showToast("Anda telah keluar dari panel admin.");
      await openAdmin();
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }
  if (event.target.closest("#load-records-button")) {
    await loadAttendanceRecords();
    return;
  }
  const removePerson = event.target.closest("[data-delete-person]");
  const removeField = event.target.closest("[data-delete-field]");
  const removeSchedule = event.target.closest("[data-delete-schedule]");
  if (removePerson || removeField || removeSchedule) {
    const button = removePerson || removeField || removeSchedule;
    const isPerson = Boolean(removePerson);
    const isSchedule = Boolean(removeSchedule);
    const resource = isPerson ? "people" : isSchedule ? "schedules" : "fields";
    const id = button.dataset[isPerson ? "deletePerson" : isSchedule ? "deleteSchedule" : "deleteField"];
    const targetName = isPerson ? "nama ini" : isSchedule ? "kategori jadwal ini" : "kolom ini";
    if (!window.confirm(`Hapus ${targetName} dari pengaturan?${isSchedule ? " Kategori yang sudah dipakai tidak dapat dihapus." : ""}`)) return;
    try {
      const result = await api(`/api/admin/${resource}/${id}`, { method: "DELETE" });
      await refreshDashboard();
      await loadForm();
      showToast(result.message || (isPerson ? "Nama berhasil dihapus." : "Kolom berhasil dihapus."));
    } catch (error) {
      showToast(error.message, true);
    }
    return;
  }
});

document.addEventListener("submit", async event => {
  const form = event.target;
  if (form.id === "admin-login-form" || form.id === "admin-setup-form") {
    event.preventDefault();
    const isSetup = form.id === "admin-setup-form";
    const data = Object.fromEntries(new FormData(form));
    const errorBox = $("#auth-error");
    try {
      await api(`/api/admin/${isSetup ? "setup" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ username: data.username, password: data.password })
      });
      await openAdmin();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  } else if (form.id === "add-person-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api("/api/admin/people", { method: "POST", body: JSON.stringify(data) });
      await refreshDashboard();
      await loadForm();
      showToast("Nama berhasil ditambahkan.");
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.matches(".schedule-editor-form")) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api(`/api/admin/schedules/${form.dataset.scheduleId}`, {
        method: "PUT",
        body: JSON.stringify(data)
      });
      await refreshDashboard();
      await loadForm();
      showToast(result.message);
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "add-schedule-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/admin/schedules", {
        method: "POST",
        body: JSON.stringify(data)
      });
      await refreshDashboard();
      await loadForm();
      showToast(result.message);
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "add-field-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api("/api/admin/fields", {
        method: "POST",
        body: JSON.stringify({ ...data, required: $("#field-required", form).checked })
      });
      await refreshDashboard();
      await loadForm();
      showToast("Kolom berhasil ditambahkan.");
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "change-password-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/admin/password", { method: "POST", body: JSON.stringify(data) });
      form.reset();
      showToast(result.message);
      await openAdmin();
    } catch (error) {
      showToast(error.message, true);
    }
  } else if (form.id === "attendance-rules-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/admin/rules", {
        method: "POST",
        body: JSON.stringify({
          toleranceMinutes: Number(data.toleranceMinutes),
          lateLimitMinutes: Number(data.lateLimitMinutes),
          earlyLimitMinutes: Number(data.earlyLimitMinutes)
        })
      });
      showToast(result.message);
      await refreshDashboard();
      await loadForm();
    } catch (error) {
      showToast(error.message, true);
    }
  }
});

if (window.location.hash === "#admin") setView("admin");
else loadForm().catch(error => showToast(error.message, true));
