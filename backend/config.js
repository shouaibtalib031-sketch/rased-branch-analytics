import "dotenv/config";
import path from "node:path";

const production=process.env.NODE_ENV==="production";
const databaseUrl=typeof process.env.DATABASE_URL==="string"?process.env.DATABASE_URL.trim():undefined;
const jwtSecret=process.env.JWT_SECRET || (production?"":"local-development-secret-change-me-32chars");
const storageRoot=path.resolve(process.env.RASED_STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || (production?"/data/rased":"./storage"));
const uploadDir=path.resolve(process.env.UPLOAD_DIR || path.join(storageRoot,"uploads"));
const outputPdfDir=path.resolve(process.env.OUTPUT_PDF_DIR || path.join(storageRoot,"reports"));
console.log("DATABASE_URL exists:", !!databaseUrl);
if(production&&!databaseUrl)throw new Error("DATABASE_URL مطلوب في بيئة الإنتاج");
if(production&&(!jwtSecret||jwtSecret.length<32))throw new Error("JWT_SECRET يجب أن يكون عشوائيًا وبطول 32 حرفًا على الأقل");
if(production&&!process.env.ADMIN_EMAIL)throw new Error("ADMIN_EMAIL مطلوب لإنشاء مدير النظام الأول");
if(production&&(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12))throw new Error("ADMIN_PASSWORD يجب أن يكون بطول 12 حرفًا على الأقل");
if(production&&["/tmp","/var/tmp","/private/tmp","/app"].some(dir=>uploadDir===dir||uploadDir.startsWith(`${dir}/`)))throw new Error("UPLOAD_DIR يجب أن يكون مسار تخزين دائم وليس مسارًا مؤقتًا داخل الحاوية");

export const config = {
  production,
  nodeEnv: process.env.NODE_ENV || "development",
  bindHost: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
  databaseUrl,
  trustProxy: process.env.TRUST_PROXY==="false"?false:1,
  jwtSecret,
  adminName: process.env.ADMIN_NAME || "مدير النظام",
  adminEmail: process.env.ADMIN_EMAIL || "admin@rased.sa",
  adminPassword: process.env.ADMIN_PASSWORD || "Admin123!",
  seedDemoData: process.env.SEED_DEMO_DATA==="true" || !production,
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.4-mini",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  storageRoot,
  uploadDir,
  outputPdfDir,
  dataDir: path.resolve(process.env.DATA_DIR || "./.data/rased")
};
