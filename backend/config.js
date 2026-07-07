import "dotenv/config";
import path from "node:path";

const production=process.env.NODE_ENV==="production";
const jwtSecret=process.env.JWT_SECRET || (production?"":"local-development-secret-change-me-32chars");
console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);
if(production&&typeof process.env.DATABASE_URL==="undefined")throw new Error("DATABASE_URL مطلوب في بيئة الإنتاج");
if(production&&(!jwtSecret||jwtSecret.length<32))throw new Error("JWT_SECRET يجب أن يكون عشوائيًا وبطول 32 حرفًا على الأقل");
if(production&&!process.env.ADMIN_EMAIL)throw new Error("ADMIN_EMAIL مطلوب لإنشاء مدير النظام الأول");
if(production&&(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12))throw new Error("ADMIN_PASSWORD يجب أن يكون بطول 12 حرفًا على الأقل");

export const config = {
  production,
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8080),
  jwtSecret,
  adminName: process.env.ADMIN_NAME || "مدير النظام",
  adminEmail: process.env.ADMIN_EMAIL || "admin@rased.sa",
  adminPassword: process.env.ADMIN_PASSWORD || "Admin123!",
  seedDemoData: process.env.SEED_DEMO_DATA==="true" || !production,
  openaiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.4-mini",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  uploadDir: path.resolve(process.env.UPLOAD_DIR || "./storage/uploads"),
  outputPdfDir: path.resolve(process.env.OUTPUT_PDF_DIR || "./output/pdf"),
  dataDir: path.resolve(process.env.DATA_DIR || "./.data/rased")
};
