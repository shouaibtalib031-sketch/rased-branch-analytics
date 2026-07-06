# رَصْد — منصة تحليل زيارات الفروع

منصة عربية RTL لإدارة تقارير زيارات الفروع وتحليلها ومراجعتها ومتابعة تنفيذها.

## المنفذ

- Backend بـNode.js وExpress.
- PostgreSQL مضمّن للتشغيل المحلي عبر PGlite، ودعم PostgreSQL خارجي عبر `DATABASE_URL`.
- JWT وbcrypt وRBAC وrate limiting وHelmet وسجل تدقيق.
- رفع متعدد محمي حتى 25MB مع فحص نوع الملف.
- قراءة PDF وXLSX وDOCX والصور.
- تحليل OpenAI من الخادم فقط عبر Responses API وStructured Outputs.
- مراجعة وتعديل قبل الاعتماد والحفظ.
- Dashboard ومقارنات 1/3/6/12 شهر وBranch Health Score وتدخل ذكي وتحليل مراقبين.
- غرفة قيادة V3 موحدة لصحة الشركة والمناطق والمدن والفروع والمراقبين.
- توقعات محفظة الفروع: تحسن، تراجع، دخول الخطر، وتجاوز 90% مع سبب وثقة.
- مؤشر صحة مركب من 9 عوامل، وصحة المناطق والمراقبين.
- Smart Alerts لانخفاض الصحة والبنود والمدن وتأخر التنفيذ واختلاف المراقبين.
- مقارنة فرعين كاملة للبنود والزيارات والملاحظات والقوة والضعف والتوقع.
- AI Insight Engine تلقائي بعد اعتماد كل زيارة، وCopilot من بيانات المنصة.
- سجل إنذارات تاريخي مستقل عن Workflow، مرتبط بالفرع والتقرير والمراقب والبند والسؤال.
- إنشاء المراقب تلقائيًا مرة واحدة بالاسم الموحّد، مع تجاهل اسم المشرف في الاستخراج.
- تصدير Excel للفروع والملاحظات وPDF للفرع.

## البناء والتشغيل

```bash
cp .env.example .env
npm ci
npm run build
npm run dev
```

حساب التطوير: `admin@rased.sa` وكلمة المرور `Admin123!`.
يجب تغيير كلمة المرور و`JWT_SECRET` قبل النشر.

الواجهة تستخدم `/api` على نفس أصل الموقع، لذلك لا تحتاج إلى عنوان API ثابت أو
إعداد CORS عند نشر الواجهة والخادم معًا.

## OpenAI

ضع المفتاح في `.env` على الخادم فقط:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.4-mini
```

دون المفتاح يعمل استخراج تجريبي معلن لاختبار رحلة الرفع والمراجعة والاعتماد.

## النشر الإنتاجي

المشروع جاهز للنشر كحاوية Docker واحدة تضم الواجهة والـBackend. نفّذ أمر البناء
في منصة الاستضافة، ثم شغّل `npm run start:production`. يجب ربط دومين الخدمة
بمنصة الاستضافة وتفعيل HTTPS من إعدادات المنصة.

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
TRUST_PROXY=true
DATABASE_URL=postgresql://user:password@host:5432/rased
JWT_SECRET=a-long-random-production-secret
ADMIN_NAME=مدير النظام
ADMIN_EMAIL=admin@your-domain.com
ADMIN_PASSWORD=a-strong-initial-password
SEED_DEMO_DATA=false
OPENAI_API_KEY=your-server-side-key
UPLOAD_DIR=/var/lib/rased/uploads
OUTPUT_PDF_DIR=/var/lib/rased/reports
```

في الإنتاج:

- يلزم PostgreSQL خارجي عبر `DATABASE_URL`؛ لا يُستخدم PGlite.
- لا تُزرع فروع أو زيارات تجريبية عند `SEED_DEMO_DATA=false`.
- يُنشأ مدير النظام الأول من متغيرات `ADMIN_*`.
- يجب توفير قرص دائم أو Object Storage لمسارات الملفات.
- فحص الصحة متاح عبر `/api/health`.
- ملف `render.yaml` جاهز للنشر على Render، و`Dockerfile` صالح لأي منصة حاويات.

## أهم مسارات API

- `POST /api/auth/login`
- `GET /api/dashboard`
- `GET /api/command-center`
- `GET /api/health/regions` و`GET /api/health/supervisors`
- `GET /api/forecasts` و`GET /api/smart-alerts`
- `GET /api/branches` و`GET /api/branches/:id`
- `GET /api/visits`
- `GET /api/warnings` و`GET /api/branches/:id/warnings`
- `POST /api/reports/upload`
- `POST /api/reports/:id/analyze`
- `GET|PUT /api/reports/:id/review`
- `POST /api/reports/:id/approve`
- `GET|PATCH /api/observations`
- `GET /api/interventions`
- `GET /api/supervisors/analytics`
- `GET /api/reports/monthly`
- `GET|PATCH /api/notifications`
- `GET|POST /api/settings`
- `GET /api/exports/branches`
- `GET /api/exports/observations`
- `GET /api/exports/branch/:id.pdf`
- `GET /api/exports/monthly/:month.pdf`
- `GET /api/compare/branches/full`
- `POST /api/assistant/ask`

## التحقق

```bash
npm run check
npm test
```

في الإنتاج استخدم bucket خاصًا للمرفقات وفحص malware ومدير أسرار ونسخًا احتياطية
مشفرة. لا توجد ثغرات عالية أو حرجة في تدقيق npm الحالي؛ توجد ملاحظتان متوسطتان
في تبعية داخلية لحزمة Excel.
