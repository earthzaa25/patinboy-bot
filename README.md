# ปฏิทินBoy Bot

## Setup ใหม่บนเครื่องใหม่

### 1. ติดตั้ง Dependencies
```bash
npm install
```

### 2. สร้างไฟล์ .env
```bash
cp .env.example .env
```
แล้วเปิดไฟล์ .env และใส่ค่าจริงจาก:
- LINE Developers Console → Channel Secret + Access Token
- Supabase → Project URL + anon public key

### 3. รันในเครื่อง
```bash
node index.js
```

### 4. Deploy ขึ้น Railway
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin <your-github-repo-url>
git push -u origin main
```
แล้วเชื่อม Railway กับ GitHub repo

### Railway Variables ที่ต้องตั้ง
- LINE_CHANNEL_SECRET
- LINE_CHANNEL_ACCESS_TOKEN
- SUPABASE_URL
- SUPABASE_ANON_KEY

### Supabase SQL (รันครั้งแรกครั้งเดียว)
```sql
create table appointments (
  id uuid default gen_random_uuid() primary key,
  user_id text not null,
  title text not null,
  meeting_date date not null,
  start_time time not null,
  end_time time,
  location text,
  notes text,
  reminded boolean default false,
  created_at timestamptz default now()
);
```

## คำสั่งที่ใช้ใน LINE
- `สวัสดี` — หน้า welcome
- `เมนู` — เมนูหลัก
- `กำหนดการ` — ดูนัดวันนี้
- `เพิ่มนัด` — เพิ่มนัดหมาย (พิมพ์แบบธรรมชาติ เช่น "พรุ่งนี้ บ่ายโมง ประชุมทีม")
