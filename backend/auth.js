import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { one } from "./db.js";

export async function login(email,password){
  const user=await one(`select u.*,r.name role,r.name_ar role_ar from users u join roles r on r.id=u.role_id where lower(email)=lower($1) and active=true`,[email]);
  if(!user||!await bcrypt.compare(password,user.password_hash)) return null;
  const payload={sub:user.id,role:user.role,name:user.full_name};
  return {token:jwt.sign(payload,config.jwtSecret,{expiresIn:"8h",issuer:"rased"}),user:{id:user.id,name:user.full_name,email:user.email,role:user.role,roleAr:user.role_ar}};
}
export function authenticate(req,res,next){const raw=req.headers.authorization||"";try{req.user=jwt.verify(raw.replace(/^Bearer /,""),config.jwtSecret,{issuer:"rased"});next()}catch{res.status(401).json({error:"يرجى تسجيل الدخول"})}}
export const allow=(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:"ليس لديك صلاحية لتنفيذ هذا الإجراء"});
