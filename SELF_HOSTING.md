# تشغيل Gia Shawarma Manager على سيرفر خاص

هذه الحزمة تحتوي على الواجهة والخلفية ومخطط قاعدة البيانات. التطبيق يستخدم PostgreSQL، ولا يحتوي هذا الملف على أي كلمة مرور أو مفتاح سري.

## المتطلبات

- Linux server (Ubuntu/Debian مناسب)
- Node.js 20 أو أحدث
- pnpm 10 أو أحدث
- PostgreSQL 14 أو أحدث
- Nginx أو خادم ملفات ثابت

## 1. تجهيز المشروع

```bash
unzip gia-shawarma-manager-self-host.zip
cd gia-shawarma-manager
cp .env.example .env
```

عدّل `.env` وضع رابط قاعدة البيانات الخاصة بك:

```env
DATABASE_URL=postgresql://gia_user:ضع_كلمة_المرور_هنا@127.0.0.1:5432/gia_shawarma
PORT=5000
```

ثم ثبّت الحزم:

```bash
corepack enable
pnpm install --frozen-lockfile
```

## 2. إنشاء جداول قاعدة البيانات

أنشئ قاعدة PostgreSQL ثم شغّل:

```bash
set -a
source .env
set +a
pnpm --filter @workspace/db push
```

بعدها افتح الموقع وأدخل الأصناف والموظفين والواردات والمصروفات من الواجهة. بيانات قاعدة Replit الحالية لا تنتقل تلقائيًا مع ملفات المصدر.

## 3. تشغيل الخلفية API

في جلسة طرفية مستقلة:

```bash
set -a
source .env
set +a
pnpm --filter @workspace/api-server run build
PORT=5000 pnpm --filter @workspace/api-server run start
```

للتشغيل الدائم استخدم systemd أو PM2، ولا تستخدم أمر `dev` في الإنتاج.

## 4. بناء الواجهة

من مجلد المشروع:

```bash
PORT=19776 BASE_PATH=/ pnpm --filter @workspace/gia-shawarma-manager run build
```

ملفات الواجهة الجاهزة للنشر ستكون داخل:

```text
artifacts/gia-shawarma-manager/dist/public
```

## 5. إعداد Nginx

اجعل Nginx يخدم مجلد `dist/public`، ومرّر طلبات `/api` إلى الخادم الخلفي على المنفذ 5000:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    root /var/www/gia-shawarma-manager/artifacts/gia-shawarma-manager/dist/public;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

بعد تفعيل الموقع، استخدم HTTPS عبر شهادة TLS مناسبة مثل Let’s Encrypt.

## ملاحظات مهمة

- الواجهة والخلفية مصممتان للعمل على نفس النطاق؛ لذلك تستخدم الواجهة `/api` بدون وضع `localhost` داخل كود المتصفح.
- غيّر `DATABASE_URL` وبيانات PostgreSQL إلى قيمك الخاصة فقط، ولا ترفع ملف `.env` إلى Git.
- العملة الافتراضية هي الروبية الإندونيسية، والواجهة تدعم العربية وBahasa Indonesia مع RTL/LTR.
- إذا كان السيرفر يستخدم نطاقًا فرعيًا أو مسارًا مختلفًا، ابنِ الواجهة مع `BASE_PATH` المطابق للمسار.