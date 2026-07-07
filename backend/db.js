import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { statusOf } from "./rules.js";

fs.mkdirSync(config.dataDir,{recursive:true});
export const db = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max: 10
    })
  : new PGlite(config.dataDir);
export const id = () => randomUUID();
export const q = async (sql, params=[]) => (await db.query(sql, params)).rows;
export const one = async (sql, params=[]) => (await q(sql, params))[0] || null;
export async function transaction(work){
  if(typeof db.connect==="function"){
    const client=await db.connect();
    try{await client.query("begin");const result=await work(client);await client.query("commit");return result}catch(error){await client.query("rollback");throw error}finally{client.release()}
  }
  if(typeof db.transaction==="function")return db.transaction(async tx=>work(tx));
  await db.query("begin");try{const result=await work(db);await db.query("commit");return result}catch(error){await db.query("rollback");throw error}
}

export async function initDatabase() {
  const schema=`
    create table if not exists roles(id text primary key,name text unique not null,name_ar text not null);
    create table if not exists users(id text primary key,role_id text references roles(id),full_name text,email text unique,password_hash text,active boolean default true,created_at timestamptz default now());
    create table if not exists regions(id text primary key,name text unique not null);
    create table if not exists branches(id text primary key,region_id text references regions(id),name text,city text,code text unique,current_score numeric(5,2),current_status text,active boolean default true,created_at timestamptz default now());
    create table if not exists supervisors(id text primary key,user_id text references users(id),employee_code text unique,active boolean default true,normalized_name text unique);
    create table if not exists operational_items(id text primary key,name text unique,weight numeric(6,3) default 1,safety_critical boolean default false,active boolean default true,sort_order int default 0);
    create table if not exists reports(id text primary key,original_name text,mime_type text,size_bytes int,storage_path text,status text default 'uploaded',uploaded_by text references users(id),created_at timestamptz default now());
    create table if not exists visits(id text primary key,report_id text references reports(id),branch_id text references branches(id),supervisor_id text references supervisors(id),visit_date date,final_score numeric(5,2),previous_score numeric(5,2),status text,workflow_state text default 'review',extraction_confidence numeric(5,2),draft_data jsonb,approved_by text references users(id),approved_at timestamptz,created_at timestamptz default now());
    create table if not exists visit_items(id text primary key,visit_id text references visits(id) on delete cascade,item_id text references operational_items(id),score numeric(5,2),notes text,previous_score numeric(5,2));
    create table if not exists observations(id text primary key,visit_id text references visits(id) on delete cascade,category text,body text,severity text,state text default 'new',is_repeated boolean default false,repetition_count int default 1,assignee_id text references users(id),due_at timestamptz,closed_at timestamptz,created_at timestamptz default now());
    create table if not exists observation_images(id text primary key,observation_id text references observations(id) on delete cascade,kind text,storage_path text,ai_findings jsonb,created_at timestamptz default now());
    create table if not exists ai_analysis(id text primary key,visit_id text references visits(id) on delete cascade,model text,prompt_version text,summary text,strengths jsonb,weaknesses jsonb,urgency boolean,structured_output jsonb,created_at timestamptz default now());
    create table if not exists recommendations(id text primary key,visit_id text references visits(id) on delete cascade,audience text,body text,intervention_type text,approved_at timestamptz);
    create table if not exists notifications(id text primary key,user_id text references users(id),type text,title text,body text,entity_type text,entity_id text,read_at timestamptz,created_at timestamptz default now());
    create table if not exists audit_logs(id bigserial primary key,actor_id text references users(id),action text,entity_type text,entity_id text,before_data jsonb,after_data jsonb,ip text,created_at timestamptz default now());
    create table if not exists login_logs(id bigserial primary key,user_id text references users(id),email text,success boolean,ip text,user_agent text,created_at timestamptz default now());
    create table if not exists timeline_events(id text primary key,branch_id text references branches(id),visit_id text references visits(id),observation_id text references observations(id),event_type text,title text,details jsonb,actor_id text references users(id),created_at timestamptz default now());
    create table if not exists observation_workflow(id text primary key,observation_id text references observations(id) on delete cascade,from_state text,to_state text,actor_id text references users(id),comment text,created_at timestamptz default now());
    create table if not exists ai_conversations(id text primary key,user_id text references users(id),question text,answer text,context jsonb,model text,created_at timestamptz default now());
    create table if not exists scheduled_reports(id text primary key,frequency text,period_start date,period_end date,status text default 'pending',storage_path text,summary jsonb,created_at timestamptz default now());
    create table if not exists system_state(key text primary key,value jsonb not null,updated_at timestamptz default now());
    create index if not exists visits_branch_date_idx on visits(branch_id,visit_date desc);
    create index if not exists observations_state_due_idx on observations(state,due_at);
    create table if not exists branch_warnings(id text primary key,branch_id text references branches(id),visit_id text references visits(id),report_id text references reports(id),supervisor_id text references supervisors(id),warning_date date not null,reason text,item_name text,question_number text,report_number text,warning_text text not null,created_at timestamptz default now());
    create index if not exists branch_warnings_branch_date_idx on branch_warnings(branch_id,warning_date desc);
  `;
  if(typeof db.exec==="function")await db.exec(schema);else await db.query(schema);
  await db.query("alter table supervisors add column if not exists normalized_name text");
  await db.query("create unique index if not exists supervisors_normalized_name_idx on supervisors(normalized_name) where normalized_name is not null");
  await seed();
  for(const [name,order] of [["توافر منتجات المنيو",21],["رصد المخالفات",22]]){
    if(!await one("select id from operational_items where name=$1",[name]))await db.query("insert into operational_items(id,name,weight,safety_critical,active,sort_order) values($1,$2,1,false,true,$3)",[id(),name,order]);
  }
}

async function seed() {
  const production=await one("select value from system_state where key='production_initialized'");
  if(production?.value===true||production?.value==="true")return;
  if (Number((await one("select count(*)::int n from branches")).n)) return;
  const roleDefs=[["system_admin","مدير النظام"],["operations_manager","مدير التشغيل"],["supervisor","المراقب"],["branch_manager","مسؤول الفرع"],["executive","الإدارة العليا"]];
  const roles={};
  for(const [name,ar] of roleDefs){const existing=await one("select id from roles where name=$1",[name]);roles[name]=existing?.id||id();if(!existing)await db.query("insert into roles values($1,$2,$3)",[roles[name],name,ar]);}
  let adminRecord=await one("select id from users where email=$1",[config.adminEmail]);
  const admin=adminRecord?.id||id();if(!adminRecord)await db.query("insert into users(id,role_id,full_name,email,password_hash) values($1,$2,$3,$4,$5)",[admin,roles.system_admin,config.adminName,config.adminEmail,await bcrypt.hash(config.adminPassword,12)]);
  const regions={}; for(const name of ["الوسطى","الشرقية","الغربية"]){const existing=await one("select id from regions where name=$1",[name]);regions[name]=existing?.id||id();if(!existing)await db.query("insert into regions values($1,$2)",[regions[name],name]);}
  const itemNames=["الهوية البصرية","النظافة العامة","الأفراد","المنتجات","المعدات والأدوات","الأمن والسلامة","التخزين","التخمير","التجهيز","الخبيز","المنتج النهائي","الخدمة والضيافة","التزام الكاشير","تعاون المشرف","تطبيق المعايير التشغيلية","توفر المنتجات","جودة العرض","ترتيب الفرع","التزام الزي الرسمي","سلامة المواد المستخدمة"];
  const items=[]; for(let i=0;i<itemNames.length;i++){const existing=await one("select id from operational_items where name=$1",[itemNames[i]]),x=existing?.id||id();items.push(x);if(!existing)await db.query("insert into operational_items values($1,$2,1,$3,true,$4)",[x,itemNames[i],itemNames[i].includes("السلامة"),i]);}
  if(!config.seedDemoData)return;
  const supervisorNames=["أحمد العتيبي","سارة القحطاني","محمد الدوسري","نورة الشهري"], supervisors=[];
  for(let i=0;i<supervisorNames.length;i++){const u=id(),s=id();await db.query("insert into users(id,role_id,full_name,email,password_hash) values($1,$2,$3,$4,$5)",[u,roles.supervisor,supervisorNames[i],`supervisor${i+1}@rased.sa`,await bcrypt.hash("Demo123!",12)]);await db.query("insert into supervisors(id,user_id,employee_code,active,normalized_name) values($1,$2,$3,true,$4)",[s,u,`SUP-${i+1}`,normalizePersonName(supervisorNames[i])]);supervisors.push(s);}
  const defs=[["فرع التحلية","الرياض","الوسطى",94,89],["فرع الواجهة","الخبر","الشرقية",91,87],["فرع الروضة","جدة","الغربية",86,82],["فرع النخيل","الرياض","الوسطى",81,84],["فرع المرجان","جدة","الغربية",76,72],["فرع المطار","الدمام","الشرقية",68,76],["فرع الفيصلية","الرياض","الوسطى",57,69],["فرع الجامعة","مكة","الغربية",63,71]];
  for(let bi=0;bi<defs.length;bi++){const [name,city,region,score,prev]=defs[bi],b=id();await db.query("insert into branches values($1,$2,$3,$4,$5,$6,$7,true,now())",[b,regions[region],name,city,`BR-${bi+1}`,score,statusOf(score)]);
    for(let vi=5;vi>=0;vi--){const v=id(),s=Math.max(45,Math.min(99,score-vi*2+(bi%3))),d=new Date(Date.now()-(vi*30+bi)*86400000).toISOString().slice(0,10);await db.query("insert into visits(id,branch_id,supervisor_id,visit_date,final_score,previous_score,status,workflow_state,extraction_confidence,approved_by,approved_at) values($1,$2,$3,$4,$5,$6,$7,'approved',98,$8,now())",[v,b,supervisors[(bi+vi)%4],d,s,vi===5?prev:s-2,statusOf(s),admin]);for(let j=0;j<7;j++)await db.query("insert into visit_items values($1,$2,$3,$4,$5,$6)",[id(),v,items[j],Math.max(40,Math.min(100,s+(j%3)*3-3)),j===1?"مراجعة تنفيذ المعيار":null,null]);if(vi===0&&bi>=4)await db.query("insert into observations(id,visit_id,category,body,severity,state,is_repeated,repetition_count,due_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id(),v,bi===6?"سلامة":"نظافة",bi===6?"طفاية الحريق منتهية الصلاحية ومسار الطوارئ غير واضح":"ملاحظة تشغيلية متكررة تحتاج متابعة","high",bi===6?"overdue":"in_progress",true,bi-1,new Date(Date.now()+(bi===6?-2:5)*86400000).toISOString()]);}}
  for(const title of ["فرع الفيصلية يحتاج تدخلًا عاجلًا","تراجع فرع المطار 8 نقاط","تكررت ملاحظة النظافة للمرة الثالثة"])await db.query("insert into notifications values($1,$2,'alert',$3,$4,'branch',null,null,now())",[id(),admin,title,"تنبيه آلي مبني على قواعد الأداء"]);
}
export { statusOf };

export function normalizePersonName(name=""){
  return name.trim().replace(/\s+/g," ").replace(/[أإآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").toLowerCase();
}
export async function ensureSupervisor(name){
  const clean=name?.trim().replace(/\s+/g," ");if(!clean)throw new Error("لم يتم استخراج اسم المراقب");
  const normalized=normalizePersonName(clean);
  let supervisor=await one("select s.id,u.full_name name from supervisors s join users u on u.id=s.user_id where s.normalized_name=$1",[normalized]);
  if(supervisor)return supervisor;
  const role=await one("select id from roles where name='supervisor'");const userId=id(),supervisorId=id(),suffix=randomUUID().slice(0,8);
  await db.query("insert into users(id,role_id,full_name,email,password_hash,active) values($1,$2,$3,$4,$5,true)",[userId,role.id,clean,`auto-${suffix}@rased.local`,await bcrypt.hash(randomUUID(),12)]);
  try{await db.query("insert into supervisors(id,user_id,employee_code,active,normalized_name) values($1,$2,$3,true,$4)",[supervisorId,userId,`AUTO-${suffix.toUpperCase()}`,normalized]);return {id:supervisorId,name:clean,created:true}}catch(error){const existing=await one("select s.id,u.full_name name from supervisors s join users u on u.id=s.user_id where s.normalized_name=$1",[normalized]);if(existing)return existing;throw error}
}
