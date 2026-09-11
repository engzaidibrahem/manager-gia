# Gia V3 — تشغيل محلي آمن

## الطريقة الرسمية

من جذر المشروع:

```bat
pnpm.cmd run dev:v3
```

وفي طرفية ثانية:

```bat
pnpm.cmd run dev:web
```

أو انقر مرتين على:

```
START-GIA-V3.bat
```

ثم افتح: http://localhost:5173  
دخول: `admin` / `admin123`

## قاعدة البيانات القانونية الوحيدة لـ V3

```
D:\gia-shawarma-manager-self-host\.data\gia-v3
```

(أو `<project-root>/.data/gia-v3` على أي جهاز)

- تُحل المسارات النسبية مثل `pglite://.data/gia-v3` من **جذر المشروع** وليس من `process.cwd()`.
- أي محاولة لفتح `artifacts\api-server\.data\gia-v3` تفشل فورًا عند الإقلاع.
- اختبارات V3 تستخدم فقط: `<project-root>/.data/gia-v3-test`

## أوامر قديمة / لا تستخدمها لـ V3

- `pnpm run dev:api` → يشير لقاعدة V2 القديمة `gia-shawarma`
- تعيين `DATABASE_URL=pglite://.data/gia-v3` مع افتراض أن `cwd` هو جذر المشروع عند تشغيل `pnpm --filter` من داخل الحزمة (كان يفتح نسخة فارغة بالخطأ)

## التحقق السريع

```bat
curl http://127.0.0.1:5000/api/healthz
```

يجب أن يظهر `absolutePath` مساويًا لمسار `.data\gia-v3` تحت جذر المشروع، و`mode: "V3"`.
