# Huawei Return ที่รันอยู่

หน้าเว็บ: `https://10.128.19.191/Huawei-Return/`  
API: `https://10.128.19.191/Huawei-Return/api/`  
เบราว์เซอร์ไม่เปิดพอร์ตฐานข้อมูล

| สิ่งที่รัน | ที่อยู่ |
|---|---|
| ไฟล์เว็บ `index.html`, `hrms-db.js` | `10.128.19.191:/var/www/html/Huawei-Return/` |
| API (systemd `huawei-return-api`, user `whs`) | `10.128.19.191` ฟังที่ `127.0.0.1:8791` |
| รหัสเชื่อมฐาน | `10.128.19.191:/opt/huawei-return/api/.env` สิทธิ์ `600` เจ้าของ `whs` |
| PostgreSQL | `10.128.19.192:15432` ฐาน `huawei_return` ผู้ใช้ `hrms` |

พอร์ต `5432` บน `10.128.19.192` เป็นพูลเลอร์ของ Supabase ไม่ใช่ฐานนี้ และพอร์ต `8787` บน `191` ถูกแอปอื่นใช้อยู่แล้ว จึงใช้ `15432` และ `8791`

ฐานข้อมูลเป็นคอนเทนเนอร์ `supabase-db` ที่มีอยู่แล้ว ไม่ได้ติดตั้ง PostgreSQL ชุดที่สอง บทบาท `hrms` เป็นเจ้าของฐาน `huawei_return` ตารางมาจาก `api/schema.sql`

nginx ที่ตอบชื่อ `10.128.19.191` คือ `/etc/nginx/conf.d/customer-service-both.conf` ซึ่ง include `/etc/nginx/snippets/huawei-return.conf` (ต้นแบบใน `deploy/huawei-return.nginx.conf`) เซิร์ฟเวอร์บล็อกใน `sites-enabled` ไม่ได้รับชื่อนี้ เพราะชื่อซ้ำถูกข้าม

รีสตาร์ท API:

```bash
sudo systemctl restart huawei-return-api
curl -fsS http://127.0.0.1:8791/Huawei-Return/api/health
```

`health` ต้องได้ `"ok": true`, `"host": "10.128.19.192"`, `"port": 15432`, `"database": "huawei_return"`

เปิด `https://10.128.19.191/Huawei-Return/`  
บัญชีแรกที่สมัครเป็นผู้ดูแล รหัสผ่านยังเป็น PBKDF2-SHA256 150,000 รอบ (hashVer 3) เหมือนเดิม ตรวจในเบราว์เซอร์ เซิร์ฟเวอร์ตรวจแบบเดียวกันที่ `POST /Huawei-Return/api/auth/login`

โหมดทดลองไม่แตะฐานข้อมูล: `index.html?demo=1`

## API

| วิธี | เส้นทาง | ใช้ทำอะไร |
|---|---|---|
| GET | `/health` | สถานะและจำนวนเอกสาร |
| GET | `/sync?rev=&id=&limit=` | อ่านเอกสารที่เปลี่ยนหลังเคอร์เซอร์ `(rev, id)` ครั้งละไม่เกิน 1,000 |
| POST | `/batch` | เขียนทีละชุด `{ops:[{op,id,data}]}` ในทรานแซกชันเดียว `op` เป็น `set`, `merge`, หรือ `update` |
| POST | `/import` | เหมือน batch หรือ `{docs:[{id,...}]}` |
| GET | `/backup?rev=&id=&limit=` | อ่านเฉพาะเคส (ไม่รวมบัญชี) ทีละหน้า |
| GET | `/docs/:id` | อ่านหนึ่งเอกสาร |
| GET | `/users` | รายชื่อบัญชีตามลำดับสมัคร หนึ่งครั้ง |
| GET | `/users/:email` | บัญชีหนึ่งราย |
| POST | `/users` | สร้างบัญชีใหม่ ถ้ามีแล้วได้ `409 exists` |
| PATCH | `/users/:email` | แก้บัญชี (อนุมัติ ระงับ รีเซ็ตรหัส) |
| POST | `/auth/login` | `{username,password}` ตรวจ PBKDF2 แล้วคืนเอกสารบัญชี |
| GET | `/search?q=` | ค้น invoice, order, PA/RO, CN, tracking, serial, SKU, CC, claim |

`data` ใส่ sentinel ได้แบบที่หน้าเว็บส่งอยู่แล้ว:

- `{"__fv":"serverTimestamp"}` เซิร์ฟเวอร์ใส่เวลา ISO
- `{"__fv":"arrayUnion","values":[...]}` ต่อท้าย history / thread / รายชื่อบัญชี โดยไม่ซ้ำ

การลบเคสคือ `deleted: true` (ถังขยะ) ไม่มีการลบแถวจริง

ดัชนีอยู่บนสถานะ วันที่รับ วันปิดงาน วันอัปเดต แพลตฟอร์ม และเลขที่หน้าจอใช้ค้น (invoice, order, PA, RO, CN, tracking, tracking ส่งคืน, serial, SKU, CC, claim) ช่องอื่นอยู่ใน `body` jsonb

API ยังไม่แยกสิทธิ์ฝั่งเซิร์ฟเวอร์ เหมือนกฎเดิมที่เปิดอ่านเขียนชุดข้อมูลนี้ได้ ให้อยู่หลัง nginx ในเครือข่ายภายในเท่านั้น
