# Huawei Return Management System

ระบบจัดการรับคืนสินค้า Marketplace (Huawei) — เว็บแอปหน้าเดียว (single-file HTML) ทำงานร่วมกับ Firebase Firestore

## ฟีเจอร์
- **Workflow 9 ขั้นตอน**: สร้างคำขอคืน → รอรับสินค้า → ได้รับสินค้าแล้ว → รอทดสอบ → กำลังทดสอบ → ทดสอบเสร็จ → เคลม Platform → ส่งคืนลูกค้า → ปิดงาน
- **Dashboard**: KPI cards + progress bar, กราฟ Return รายวัน 7 วัน, donut สถานะ/Platform, สาเหตุที่พบบ่อย, การแจ้งเตือนล่าสุด
- **Flow การทำงาน**: แผนผัง 6 ขั้นตอน + Status Flow timeline
- **Trendline**: แนวโน้มสภาพสินค้า/เหตุผลการคืนรายเดือน + ตารางสรุป
- **จัดการเคส**: ค้นหา/กรอง, เลือกสถานะในตาราง, chip filter (รับเข้า/ทดสอบ/ดำเนินการ/ปิดงาน/ได้รับสินค้าผิด)
- **IPQC / Service**: บันทึกผลทดสอบ (ผ่าน/ไม่ผ่าน/สินค้าเสีย), SKU/Serial/IMEI
- **มุมมองฟอร์มตามบทบาท**: ทั้งหมด / ฝ่ายขาย / คลัง / IPQC
- **Audit Log**: บันทึกผู้ใช้งาน + ประวัติการเปลี่ยนสถานะ
- แนบรูปภาพ, ลายเซ็น (mouse/touch), พิมพ์ตั๋วรับคืน, Export CSV (Excel)

## การใช้งาน
เปิด `index.html` ในเบราว์เซอร์ได้เลย ข้อมูลซิงก์ผ่าน Firebase Firestore (collection `return_cases`) และสำรองไว้ใน `localStorage` ของเครื่อง

## Deploy บน GitHub Pages
1. Push repository นี้ขึ้น GitHub
2. Settings → Pages → Branch: `main` / root
3. เข้าใช้งานที่ `https://<username>.github.io/<repo>/`

## เทคโนโลยี
- HTML/CSS/JavaScript (ไม่มี build step)
- Chart.js 4.4.1 (CDN)
- Firebase Firestore (compat SDK 10.12.5)
- Tabler Icons, IBM Plex Sans Thai

> หมายเหตุ: Firebase config ที่ฝังในไฟล์เป็น client config (public โดยธรรมชาติ) — ความปลอดภัยของข้อมูลควรกำหนดที่ Firestore Security Rules
