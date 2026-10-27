# Hadir — aplikasi absensi

Aplikasi absensi berbasis JavaScript. Frontend statis di-host Netlify, API berjalan sebagai Netlify Function, database menggunakan Supabase PostgreSQL, dan foto disimpan di Supabase Storage. Form absensi tidak memerlukan login; panel pengaturan dan analisis hanya tersedia untuk admin.

## Deploy ke Netlify dan Supabase

### 1. Siapkan database Supabase

1. Buat project Supabase baru.
2. Buka **SQL Editor**, lalu jalankan seluruh isi [`supabase/schema.sql`](./supabase/schema.sql). Ini adalah setup awal kanonis untuk database baru dan mencakup skema aplikasi terkini: lima kategori shift, pilihan shift per absensi, snapshot jam shift untuk mempertahankan aturan historis, aturan absensi default, pembatasan akses, rate limiter admin, dan bucket privat `attendance-photos`.
3. Dari **Project Settings → API**, salin **Project URL** dan **service_role key**. Jangan pernah menaruh service role key di kode browser, repositori, atau variabel yang berawalan `VITE_`/`NEXT_PUBLIC_`.

### 2. Deploy situs di Netlify

1. Hubungkan repositori ini ke Netlify. Konfigurasi pada `netlify.toml` mengatur folder publik, fungsi API, serta rewrite `/api/*`.
2. Di **Site configuration → Environment variables**, tambahkan:
   - `SUPABASE_URL`: Project URL Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service role key dari Supabase.
   - `SESSION_SECRET`: secret acak minimal 32 byte. Buat dengan `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
   - `APP_TIME_ZONE` (opsional): `Asia/Makassar` untuk zona UTC+08. Jika tidak disetel atau nilainya tidak valid, server memakai `Asia/Makassar`; nilai tidak valid akan dicatat sebagai peringatan pada log fungsi. Zona waktu lain yang valid misalnya `Asia/Jakarta` atau `Asia/Jayapura`.
   - `COOKIE_SECURE`: `true`.
   - `TRUST_PROXY`: `true`.
3. Deploy ulang setelah mengisi environment variables.
4. Buka situs, masuk ke tab **Admin**, lalu buat akun admin pertama dengan kata sandi minimal 12 karakter. Buat akun sebelum membagikan tautan absensi.
5. Tambahkan nama karyawan dan kolom formulir dari **Pengaturan formulir**.

Database Supabase baru dimulai kosong. Database SQLite lokal di `data/absensi.db` dan kunci sesi lokal tidak dipindahkan maupun dihapus.

### Memperbarui project Supabase yang sudah dibuat

Untuk project Supabase yang sudah memiliki data, **jangan jalankan ulang** [`supabase/schema.sql`](./supabase/schema.sql), karena file tersebut ditujukan untuk setup awal project baru. Jalankan migrasi melalui **SQL Editor** Supabase dengan urutan berikut sebelum deploy kode terbaru:

1. [`supabase/migrations/20261009_employee_selected_schedule.sql`](./supabase/migrations/20261009_employee_selected_schedule.sql), jika belum pernah dijalankan. Migrasi ini menambahkan shift pada tiap catatan absensi. Catatan lama memakai kategori yang dahulu ditetapkan untuk karyawan; jika informasi itu tidak tersedia, catatan lama diisi kategori **Karyawan Shift Pagi**. Migrasi juga mengunci kategori shift per karyawan per tanggal.
2. [`supabase/migrations/20261009_attendance_schedule_snapshots.sql`](./supabase/migrations/20261009_attendance_schedule_snapshots.sql). Migrasi ini menyimpan snapshot jam masuk dan pulang pada setiap absensi. Untuk catatan lama, snapshot diisi dari jam kategori saat migrasi dijalankan (atau 07.00–17.00 jika kategori tidak ditemukan), karena perubahan jam terdahulu tidak memiliki riwayat yang dapat dipulihkan.
3. [`supabase/migrations/20261012_custom_attendance_schedules.sql`](./supabase/migrations/20261012_custom_attendance_schedules.sql). Migrasi ini menyimpan nama kategori pada setiap catatan agar perubahan nama shift tidak mengubah label riwayat, serta memastikan nama kategori unik tanpa membedakan huruf besar/kecil.
4. [`supabase/migrations/20261027_early_arrival_limit.sql`](./supabase/migrations/20261027_early_arrival_limit.sql). Migrasi ini menambahkan batas datang awal yang dapat diatur admin dan bernilai awal 15 menit sebelum jam masuk.
5. [`supabase/migrations/20261027_attendance_history_filter_index.sql`](./supabase/migrations/20261027_attendance_history_filter_index.sql). Migrasi ini menambahkan indeks untuk mempercepat filter riwayat berdasarkan karyawan dan tanggal.

Kelima migrasi aman dijalankan ulang.

### Pengembangan lokal

1. Pasang Node.js 22 atau yang lebih baru.
2. Salin `.env.example` menjadi `.env`, lalu isi variabel Supabase dan secret di atas. File `.env` diabaikan Git.
3. Instal dependensi dan jalankan server:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

4. Buka `http://localhost:5080`. Untuk menguji rewrite dan fungsi Netlify secara lokal, instal Netlify CLI secara terpisah lalu jalankan `netlify dev`.

## Fitur dan aturan

- Foto wajib diambil langsung dari kamera melalui browser; pemilihan berkas galeri tidak tersedia pada formulir. Peserta dapat memilih kamera depan atau belakang jika perangkat mendukungnya. Pratinjau dan foto hasil kamera depan dicerminkan seperti tampilan cermin; kamera belakang tidak dicerminkan. Browser meminta izin kamera dan situs harus dibuka melalui HTTPS (localhost diperbolehkan untuk pengembangan). Batas foto 3,5 MiB agar formulir tetap di bawah batas payload Netlify Functions. Akses kamera membantu mencegah pemilihan foto lama, tetapi tidak membuktikan lokasi pengambilan atau mencegah pemalsuan kamera/perangkat.
- Setiap absensi wajib memilih shift aktif dan jenis **Datang** atau **Pulang**. Shift yang dipilih pada absensi pertama hari itu dikunci; absensi berikutnya pada tanggal yang sama harus menggunakan shift tersebut. Pada tanggal berikutnya, karyawan bebas memilih shift yang sedang dijalani. Setiap karyawan hanya dapat mengirim satu absensi untuk tiap jenis pada tanggal yang sama.
- Admin dapat menambah/menghapus nama, menambahkan kolom bertipe teks, angka, tanggal, dropdown, atau centang, serta memilih apakah kolom tambahan wajib diisi.
- Riwayat pada bagian Aktivitas Terbaru tidak dimuat saat dashboard dibuka. Admin dapat memfilter berdasarkan karyawan dan tanggal, lalu memintanya saat diperlukan; catatan ditampilkan bertahap sebanyak 25 per permintaan.
- Admin dapat mengubah nama dan jam kategori, serta menambah kategori shift baru. Kategori yang sudah digunakan pada riwayat absensi tidak dapat dihapus; kategori yang belum pernah dipakai dapat dihapus. Database baru memuat kategori awal Karyawan Shift Pagi (07.00–17.00), Karyawan Shift Siang (14.00–22.00), Admin 1 (07.00–17.00), Admin 2 (09.00–18.00), dan Koordinator (11.00–19.30). Karyawan memilih kategori yang sesuai dengan rolling shift mereka ketika mengisi formulir.
- Absensi Datang tetap diterima meski dilakukan lebih dari 15 menit sebelum jam masuk shift. Admin dapat mengatur ambang nilai plus datang awal (default 15 menit, rentang 0–360 menit); rekap mencatat jumlah kedatangan yang lebih awal daripada ambang tersebut secara terpisah. Toleransi keterlambatan awal 5 menit dan batas terlambat awal 15 menit berlaku untuk semua kategori. Jam pulang tiap kategori harus lebih akhir daripada jam masuk pada hari yang sama.
- Setiap catatan absensi menyimpan snapshot nama dan jam kategori yang berlaku ketika catatan dibuat. Rekap memakai snapshot tersebut, sehingga perubahan nama atau jam kategori tidak mengubah label dan perhitungan catatan sebelumnya. Jika nama atau jam kategori diubah di antara pencatatan Datang dan Pulang, setiap catatan mempertahankan snapshot masing-masing.
- Datang sampai batas toleransi tidak dihitung terlambat; lewat toleransi sampai batas terlambat dihitung terlambat; setelah batas terlambat dihitung tidak masuk. Toleransi dan batas terlambat tetap merupakan aturan global yang perubahan nilainya diterapkan saat rekap dihitung ulang.
- Rekap bulanan menampilkan jumlah hari masuk, kategori shift yang digunakan, terlambat, semua kedatangan awal, kedatangan awal melebihi ambang nilai plus, pulang terlambat, dan tidak masuk/libur per karyawan. Masuk menghitung hari dengan absensi Datang yang tidak melewati batas keterlambatan; tidak masuk dihitung bila tidak ada absensi Datang atau absensi Datang melewati batas tersebut. Untuk hari ini, karyawan tanpa absensi baru dihitung tidak masuk setelah jam pulang kategori yang paling akhir.
- Catatan absensi lama yang sudah ada sebelum migrasi snapshot akan menggunakan jam kategori terkini pada saat migrasi dilakukan. Karena riwayat perubahan jam sebelumnya tidak tersimpan, nilai historis sebelum migrasi tidak dapat dipulihkan.
- Tanggal dan jam absensi dihitung memakai `APP_TIME_ZONE` (default `Asia/Makassar`), bukan zona waktu sementara mesin server Netlify.
- Data foto berada di bucket Supabase Storage privat. Tautan foto panel admin ditandatangani dan hanya berlaku singkat.
- Tabel database mengaktifkan Row Level Security tanpa akses langsung untuk pengguna anonim; API memakai service role key hanya di lingkungan server.
- Kata sandi admin disimpan sebagai hash scrypt. Sesi memakai cookie HTTP-only, SameSite Strict, berdurasi delapan jam, serta ditandatangani `SESSION_SECRET`.
- Percobaan pembuatan akun dan login admin dibatasi hingga lima kali per menit per alamat IP dengan penghitung atomik di database.

## Operasional dan keamanan

- Simpan `SUPABASE_SERVICE_ROLE_KEY` dan `SESSION_SECRET` sebagai rahasia environment Netlify. Jika `SESSION_SECRET` berubah, sesi admin aktif akan tidak berlaku.
- Atur backup database dan Storage dari project Supabase, dan pantau kuota penyimpanan karena foto tetap menambah penggunaan storage.
- Jangan membuat bucket foto publik atau menambahkan policy anonim untuk tabel aplikasi.
- Untuk menonaktifkan akses, hapus atau ubah environment variables di Netlify dan gunakan pengaturan project Supabase.
