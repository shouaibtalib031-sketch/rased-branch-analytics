import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { fileTypeFromFile } from "file-type";
import { config } from "./config.js";
import { login,authenticate,allow } from "./auth.js";
import { db,id,q,one,statusOf,ensureSupervisor,transaction } from "./db.js";
import { analyzeFile } from "./analyzer.js";
import { branchHealth,branchHealthDetails,periods } from "./analytics.js";
import { executiveDashboard,cityHeatmap,branchTimeline,itemTrends,prediction,compare,askAssistant,clearCache,commandCenter,regionalHealth,supervisorHealth,portfolioForecast,smartAlerts,fullBranchComparison,generateVisitInsight } from "./enterprise.js";
import { generalManagerData, reportPeriod, writeGeneralManagerPdf } from "./reporting.js";
import { resetOperationalData } from "./reset.js";

fs.mkdirSync(config.uploadDir,{recursive:true});
const allowed=new Set([".pdf",".xlsx",".docx",".png",".jpg",".jpeg",".webp"]);
const validMimeByExtension={".pdf":["application/pdf"],".xlsx":["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/zip"],".docx":["application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/zip"],".png":["image/png"],".jpg":["image/jpeg"],".jpeg":["image/jpeg"],".webp":["image/webp"]};
const upload=multer({storage:multer.diskStorage({destination:config.uploadDir,filename:(_,f,cb)=>cb(null,`${randomUUID()}${path.extname(f.originalname).toLowerCase()}`)}),limits:{fileSize:config.maxUploadBytes,files:20},fileFilter:(_,f,cb)=>allowed.has(path.extname(f.originalname).toLowerCase())?cb(null,true):cb(new Error("نوع الملف غير مدعوم"))});
export const api=Router();
const rows=async(client,sql,params=[]) => (await client.query(sql,params)).rows;
const first=async(client,sql,params=[]) => (await client.query(sql,params)).rows[0] || null;
const cleanKey=value=>String(value||"").trim().replace(/\s+/g," ").replace(/[أإآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه").replace(/[^\p{L}\p{N}]+/gu," ").toLowerCase();
const textOf=value=>String(value??"").trim();
const safeScore=value=>Math.max(0,Math.min(100,Number(value)||0));
const dueFor=severity=>new Date(Date.now()+({critical:2,high:3,medium:7,low:14}[severity]||7)*86400000).toISOString();
const severityOf=o=>{
  const raw=textOf(o?.severity).toLowerCase(),body=cleanKey(`${o?.body||""} ${o?.description||""}`);
  if(["critical","high","medium","low"].includes(raw))return raw;
  if(/خطر|حرج|سلامه|تالف|منتهي|حريق|اصابه|critical/.test(body))return "critical";
  if(/عاجل|ضعيف|مخالف|متاخر|high/.test(body))return "high";
  if(/بسيط|low/.test(body))return "low";
  return "medium";
};
const categoryOf=(body="",fallback="تشغيل عام")=>{
  const key=cleanKey(`${fallback} ${body}`);
  const pairs=[["نظافة","نظاف"],["سلامة","سلامه امن حريق خطر"],["تخزين","تخزين مستودع"],["منتج","منتج منتجات جوده تالف"],["تخمير","تخمير"],["معدات","معدات ادوات قلايه فرن"],["أفراد","افراد موظف فريق"],["خدمة","خدمه ضيافه كاشير"],["هوية بصرية","هويه بصر"],["الزي الرسمي","زي رسمي"],["الخبيز","خبيز خبز"],["التجهيز","تجهيز"]];
  return pairs.find(([,words])=>words.split(" ").some(w=>key.includes(w)))?.[0] || textOf(fallback) || "تشغيل عام";
};
function normalizeDraft(input={}){
  const observations=[...(input.observations||[]),...(input.notes||[]),...(input.findings||[])].map(o=>({
    body:textOf(o.body||o.note||o.description||o.text),
    category:categoryOf(o.body||o.note||o.description||o.text,o.category||o.itemName||o.item),
    severity:severityOf(o),
    recommendation:textOf(o.recommendation||o.action)
  })).filter(o=>o.body);
  const imageObservations=(input.imageFindings||[]).map(o=>({
    body:textOf(o.description),
    category:categoryOf(o.description,o.category),
    severity:severityOf(o),
    recommendation:"مراجعة الصورة وربطها بإجراء تصحيحي",
    imageFinding:o
  })).filter(o=>o.body);
  const warnings=[...(input.warnings||[]),...observations.filter(o=>/انذار|إنذار|warning/i.test(o.body)).map(o=>({reason:o.body,itemName:o.category,questionNumber:"",warningText:o.body}))].map(w=>({
    reason:textOf(w.reason||w.cause||w.warningText),
    itemName:textOf(w.itemName||w.item||w.category)||categoryOf(w.warningText||w.reason),
    questionNumber:textOf(w.questionNumber||w.questionNo||w.question),
    warningText:textOf(w.warningText||w.text||w.body||w.reason)
  })).filter((w,i,a)=>w.warningText&&a.findIndex(x=>cleanKey(x.warningText)===cleanKey(w.warningText))===i);
  return {
    ...input,
    branchName:textOf(input.branchName||input.branch||input.branch_name)||"فرع غير محدد",
    city:textOf(input.city)||"غير محددة",
    region:textOf(input.region)||"غير محددة",
    visitDate:textOf(input.visitDate||input.date)||new Date().toISOString().slice(0,10),
    inspectorName:textOf(input.inspectorName||input.monitorName||input.supervisorName||input.inspector)||"مراقب غير محدد",
    reportNumber:textOf(input.reportNumber||input.reportNo),
    finalScore:safeScore(input.finalScore||input.score||input.final_score),
    items:(input.items||[]).map(x=>({name:textOf(x.name||x.item||x.category)||"بند تشغيلي",score:safeScore(x.score||x.grade),notes:textOf(x.notes||x.note||x.comment)})).filter(x=>x.name),
    observations:[...observations,...imageObservations],
    warnings,
    managementRecommendation:textOf(input.managementRecommendation)||"متابعة تنفيذ الملاحظات حسب درجة الخطورة.",
    branchRecommendation:textOf(input.branchRecommendation)||"معالجة الملاحظات وتوثيق الإغلاق بالصور.",
    urgent:Boolean(input.urgent||observations.some(o=>["high","critical"].includes(o.severity))||safeScore(input.finalScore)<60)
  };
}
async function ensureBranch(client,d){
  const name=d.branchName,city=d.city,regionName=d.region;
  let branch=await first(client,"select b.id,b.current_score,b.current_status from branches b where lower(trim(b.name))=lower(trim($1)) limit 1",[name]);
  if(branch)return branch;
  let region=await first(client,"select id from regions where name=$1",[regionName]);
  if(!region){region={id:id()};await client.query("insert into regions(id,name) values($1,$2)",[region.id,regionName])}
  branch={id:id(),current_score:0,current_status:"danger"};
  await client.query("insert into branches(id,region_id,name,city,code,current_score,current_status,active) values($1,$2,$3,$4,$5,0,'danger',true)",[branch.id,region.id,name,city,`AI-${Date.now()}-${randomUUID().slice(0,4)}`]);
  return branch;
}
async function ensureOperationalItem(client,name){
  const itemName=textOf(name)||"تشغيل عام";
  let item=await first(client,"select id,name from operational_items where lower(trim(name))=lower(trim($1))",[itemName]);
  if(item)return item;
  item={id:id(),name:itemName};
  await client.query("insert into operational_items(id,name,weight,safety_critical,active,sort_order) values($1,$2,1,$3,true,999)",[item.id,item.name,/سلامة|امن|مواد/i.test(item.name)]);
  return item;
}
async function persistVisitAnalysis(client,{visit,branchId,supervisorId,draft,userId}){
  const d=normalizeDraft(draft);
  await client.query("delete from observation_images where observation_id in (select id from observations where visit_id=$1)",[visit.id]);
  await client.query("delete from observation_workflow where observation_id in (select id from observations where visit_id=$1)",[visit.id]);
  for(const table of ["timeline_events","recommendations","ai_analysis","branch_warnings","observations","visit_items"])await client.query(`delete from ${table} where visit_id=$1`,[visit.id]);
  for(const item of d.items){
    const oi=await ensureOperationalItem(client,item.name);
    const previous=await first(client,`select vi.score from visit_items vi join visits v on v.id=vi.visit_id where v.branch_id=$1 and vi.item_id=$2 and v.id<>$3 order by v.visit_date desc,v.created_at desc limit 1`,[branchId,oi.id,visit.id]);
    await client.query("insert into visit_items(id,visit_id,item_id,score,notes,previous_score) values($1,$2,$3,$4,$5,$6)",[id(),visit.id,oi.id,item.score,item.notes,previous?.score??null]);
  }
  const prior=await rows(client,`select o.body,o.category from observations o join visits v on v.id=o.visit_id where v.branch_id=$1 and v.id<>$2`,[branchId,visit.id]);
  for(const obs of d.observations){
    const item=await ensureOperationalItem(client,obs.category);
    const matches=prior.filter(x=>cleanKey(x.category)===cleanKey(obs.category)&&(cleanKey(x.body)===cleanKey(obs.body)||cleanKey(x.body).includes(cleanKey(obs.body))||cleanKey(obs.body).includes(cleanKey(x.body))));
    const observationId=id(),repetitionCount=matches.length+1,isRepeated=matches.length>0;
    await client.query("insert into observations(id,visit_id,item_id,category,body,severity,state,is_repeated,repetition_count,due_at) values($1,$2,$3,$4,$5,$6,'new',$7,$8,$9)",[observationId,visit.id,item.id,obs.category,obs.body,obs.severity,isRepeated,repetitionCount,dueFor(obs.severity)]);
    await client.query("insert into observation_workflow(id,observation_id,from_state,to_state,actor_id,comment) values($1,$2,null,'new',$3,$4)",[id(),observationId,userId,"تم إنشاء متابعة تلقائية من تقرير الزيارة"]);
    await client.query("insert into timeline_events(id,branch_id,visit_id,observation_id,event_type,title,details,actor_id) values($1,$2,$3,$4,'observation_created','اكتشاف ملاحظة',$5,$6)",[id(),branchId,visit.id,observationId,JSON.stringify({body:obs.body,category:obs.category,severity:obs.severity,repetitionCount}),userId]);
    if(obs.imageFinding){
      const reportPath=(await first(client,"select storage_path from reports where id=$1",[visit.report_id]))?.storage_path||"";
      await client.query("insert into observation_images(id,observation_id,kind,storage_path,ai_findings) values($1,$2,'evidence',$3,$4)",[id(),observationId,reportPath,JSON.stringify(obs.imageFinding)]);
    }
  }
  for(const warning of d.warnings){
    await client.query("insert into branch_warnings(id,branch_id,visit_id,report_id,supervisor_id,warning_date,reason,item_name,question_number,report_number,warning_text) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id(),branchId,visit.id,visit.report_id,supervisorId,d.visitDate,warning.reason,warning.itemName,warning.questionNumber,d.reportNumber||visit.report_id,warning.warningText]);
    await client.query("insert into timeline_events(id,branch_id,visit_id,event_type,title,details,actor_id) values($1,$2,$3,'warning_recorded','تسجيل إنذار',$4,$5)",[id(),branchId,visit.id,JSON.stringify(warning),userId]);
  }
  const interventionType=d.urgent?"urgent_visit":Number(d.finalScore)<60?"urgent_intervention":Number(d.finalScore)-Number(visit.previous_score||d.finalScore)<-10?"re_evaluation":"normal_followup";
  await client.query("insert into recommendations(id,visit_id,audience,body,intervention_type,approved_at) values($1,$2,'management',$3,$4,now()),($5,$2,'branch',$6,$7,now())",[id(),visit.id,d.managementRecommendation,interventionType,id(),d.branchRecommendation,interventionType]);
  await client.query("insert into ai_analysis(id,visit_id,model,prompt_version,summary,strengths,weaknesses,urgency,structured_output) values($1,$2,$3,'pipeline-v4',$4,$5,$6,$7,$8)",[id(),visit.id,config.openaiKey?config.openaiModel:"deterministic-pipeline",d.summary||"تم تحليل التقرير وحفظ جميع المخرجات التشغيلية.",JSON.stringify(d.items.filter(i=>i.score>=85)),JSON.stringify(d.items.filter(i=>i.score<70)),d.urgent,JSON.stringify(d)]);
  await client.query("insert into timeline_events(id,branch_id,visit_id,event_type,title,details,actor_id) values($1,$2,$3,'visit_approved','اعتماد زيارة',$4,$5)",[id(),branchId,visit.id,JSON.stringify({score:d.finalScore,observations:d.observations.length,warnings:d.warnings.length}),userId]);
  const adminUsers=await rows(client,`select u.id from users u join roles r on r.id=u.role_id where r.name in('system_admin','operations_manager') and u.active=true`);
  if(d.urgent||Number(d.finalScore)<60||Number(d.finalScore)-Number(visit.previous_score||d.finalScore)<-10||d.observations.some(o=>["high","critical"].includes(o.severity))){
    for(const user of adminUsers)await client.query("insert into notifications(id,user_id,type,title,body,entity_type,entity_id) values($1,$2,'alert',$3,$4,'visit',$5)",[id(),user.id,`زيارة تحتاج متابعة: ${d.branchName}`,`التقييم ${d.finalScore}%، الملاحظات ${d.observations.length}، الإنذارات ${d.warnings.length}`,visit.id]);
  }
  return {observations:d.observations.length,warnings:d.warnings.length,items:d.items.length};
}
api.post("/auth/login",async(req,res)=>{const data=await login(req.body.email,req.body.password);await db.query("insert into login_logs(user_id,email,success,ip,user_agent) values($1,$2,$3,$4,$5)",[data?.user?.id||null,req.body.email,!!data,req.ip,req.headers["user-agent"]||""]);if(!data)return res.status(401).json({error:"البريد الإلكتروني أو كلمة المرور غير صحيحة"});res.json(data)});
api.use(authenticate);
api.use((req,res,next)=>["GET","HEAD","OPTIONS"].includes(req.method)||req.headers["x-requested-with"]==="RasedWeb"?next():res.status(403).json({error:"طلب غير موثوق: رمز حماية CSRF مفقود"}));
api.get("/auth/me",async(req,res)=>res.json(await one("select u.id,u.full_name name,u.email,r.name role,r.name_ar role_ar from users u join roles r on r.id=u.role_id where u.id=$1",[req.user.sub])));

api.get("/dashboard",async(req,res)=>{
 const p=reportPeriod(req.query),params=[p.from,p.to];
 const summary=await one(`select count(distinct branch_id)::int branches,round(avg(final_score),1) average,count(distinct branch_id) filter(where final_score>=90)::int excellent,count(distinct branch_id) filter(where final_score between 70 and 89)::int medium,count(distinct branch_id) filter(where final_score<70)::int weak,count(distinct branch_id) filter(where final_score<60)::int danger,count(*)::int visits from visits where workflow_state='approved' and visit_date between $1 and $2`,params);
 const trend=await q(`select to_char(date_trunc('month',visit_date),'YYYY-MM') as period,round(avg(final_score),1) as value from visits where workflow_state='approved' and visit_date between $1 and $2 group by 1 order by 1`,params);
 const ranked=await q(`select distinct on (b.id) b.id,b.name,b.city,r.name region,v.final_score score,v.status,v.visit_date,v.final_score-v.previous_score delta,u.full_name supervisor from visits v join branches b on b.id=v.branch_id join regions r on r.id=b.region_id left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where v.workflow_state='approved' and v.visit_date between $1 and $2 order by b.id,v.visit_date desc`,params);
 const top=[...ranked].sort((a,b)=>Number(b.score)-Number(a.score)).slice(0,5),bottom=[...ranked].sort((a,b)=>Number(a.score)-Number(b.score)).slice(0,5);
 const issues=await q("select o.category,count(*)::int count from observations o join visits v on v.id=o.visit_id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by o.category order by count desc limit 5",params);
 res.json({period:p,summary:{...summary,intervention:summary.weak},trend,top,bottom,issues});
});
api.get("/executive",allow("system_admin","operations_manager","executive"),async(_req,res)=>res.json(await executiveDashboard()));
api.get("/command-center",allow("system_admin","operations_manager","executive"),async(_req,res)=>res.json(await commandCenter()));
api.get("/health/regions",async(_req,res)=>res.json(await regionalHealth()));
api.get("/health/supervisors",async(_req,res)=>res.json(await supervisorHealth()));
api.get("/forecasts",async(_req,res)=>res.json(await portfolioForecast()));
api.get("/smart-alerts",async(_req,res)=>res.json(await smartAlerts()));
api.get("/heatmap",async(_req,res)=>res.json(await cityHeatmap()));
api.get("/branches/:id/timeline",async(req,res)=>res.json(await branchTimeline(req.params.id)));
api.get("/branches/:id/warnings",async(req,res)=>res.json(await q(`select w.*,b.name branch,b.city,u.full_name inspector,r.original_name report_name from branch_warnings w join branches b on b.id=w.branch_id left join supervisors s on s.id=w.supervisor_id left join users u on u.id=s.user_id left join reports r on r.id=w.report_id where w.branch_id=$1 order by w.warning_date desc,w.created_at desc`,[req.params.id])));
api.get("/branches/:id/items/trends",async(req,res)=>res.json(await itemTrends(req.params.id)));
api.get("/branches/:id/prediction",async(req,res)=>res.json(await prediction(req.params.id)));
api.get("/compare",async(req,res)=>{try{res.json(await compare(req.query.kind,req.query.a,req.query.b))}catch(e){res.status(400).json({error:e.message})}});
api.get("/compare/branches/full",async(req,res)=>{try{res.json(await fullBranchComparison(req.query.a,req.query.b))}catch(e){res.status(400).json({error:e.message})}});
api.post("/assistant/ask",async(req,res)=>{if(!req.body.question?.trim())return res.status(400).json({error:"اكتب سؤالك"});res.json(await askAssistant(req.user.sub,req.body.question.trim()))});
api.get("/warnings",async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize)||50)),p=reportPeriod(req.query),branch=Boolean(req.query.branchId),params=branch?[p.from,p.to,req.query.branchId,pageSize,(page-1)*pageSize]:[p.from,p.to,pageSize,(page-1)*pageSize];const items=await q(`select w.*,b.name branch,b.city,u.full_name inspector,r.original_name report_name from branch_warnings w join branches b on b.id=w.branch_id left join supervisors s on s.id=w.supervisor_id left join users u on u.id=s.user_id left join reports r on r.id=w.report_id where w.warning_date between $1 and $2 ${branch?"and w.branch_id=$3":""} order by w.warning_date desc,w.created_at desc limit $${branch?4:3} offset $${branch?5:4}`,params),total=await one(`select count(*)::int total from branch_warnings w where w.warning_date between $1 and $2 ${branch?"and w.branch_id=$3":""}`,branch?[p.from,p.to,req.query.branchId]:[p.from,p.to]);res.json({items,pagination:{page,pageSize,total:total.total,pages:Math.ceil(total.total/pageSize)}})});
api.get("/reports/general-manager",allow("system_admin","operations_manager","executive"),async(req,res)=>res.json(await generalManagerData(req.query)));
api.get("/exports/general-manager.pdf",allow("system_admin","operations_manager","executive"),async(req,res)=>{const data=await generalManagerData(req.query);res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(`rased-general-manager-${data.period.from}-${data.period.to}.pdf`)}`);await writeGeneralManagerPdf(res,data)});
async function branchList(order="desc",limit=100){return q(`select b.id,b.name,b.city,r.name region,b.current_score score,b.current_status status,(select v.final_score-v.previous_score from visits v where v.branch_id=b.id and v.workflow_state='approved' order by visit_date desc,created_at desc limit 1) delta,(select u.full_name from visits v join supervisors s on s.id=v.supervisor_id join users u on u.id=s.user_id where v.branch_id=b.id and v.workflow_state='approved' order by visit_date desc,v.created_at desc limit 1) supervisor,(select visit_date from visits v where v.branch_id=b.id and v.workflow_state='approved' order by visit_date desc,v.created_at desc limit 1) visit_date,(select count(*)::int from visits v where v.branch_id=b.id and workflow_state='approved') visits from branches b join regions r on r.id=b.region_id where b.active=true order by b.current_score ${order} limit $1`,[limit])}
api.get("/branches",async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize)||50));let rows=await branchList(req.query.sort==="asc"?"asc":"desc",1000);if(req.query.search)rows=rows.filter(x=>`${x.name} ${x.city} ${x.region}`.includes(req.query.search));res.json({items:rows.slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total:rows.length,pages:Math.ceil(rows.length/pageSize)}})});
api.get("/visits",async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize)||50)),includeDrafts=req.query.includeDrafts==="true",where=includeDrafts?"true":"v.workflow_state='approved'",total=await one(`select count(*)::int total from visits v where ${where}`);res.json({items:await q(`select v.id,v.visit_date,v.final_score,v.previous_score,v.status,v.workflow_state,b.name branch,b.city,r.name region,u.full_name supervisor from visits v left join branches b on b.id=v.branch_id left join regions r on r.id=b.region_id left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where ${where} order by v.visit_date desc,v.created_at desc limit $1 offset $2`,[pageSize,(page-1)*pageSize]),pagination:{page,pageSize,total:total.total,pages:Math.ceil(total.total/pageSize)}})});
api.get("/visits/:id",async(req,res)=>{const visit=await one(`select v.*,b.name branch,b.city,r.name region,u.full_name supervisor,rep.original_name report_name from visits v left join branches b on b.id=v.branch_id left join regions r on r.id=b.region_id left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id left join reports rep on rep.id=v.report_id where v.id=$1`,[req.params.id]);if(!visit)return res.status(404).json({error:"الزيارة غير موجودة"});res.json({visit,items:await q(`select oi.name,vi.score,vi.notes,vi.previous_score from visit_items vi join operational_items oi on oi.id=vi.item_id where vi.visit_id=$1 order by oi.sort_order`,[req.params.id]),observations:await q("select * from observations where visit_id=$1 order by created_at desc",[req.params.id]),warnings:await q("select * from branch_warnings where visit_id=$1 order by warning_date desc",[req.params.id])})});
api.post("/branches",allow("system_admin","operations_manager"),async(req,res)=>{const {name,city,region}=req.body;if(!name?.trim()||!city?.trim()||!region?.trim())return res.status(400).json({error:"اسم الفرع والمدينة والمنطقة مطلوبة"});let r=await one("select id from regions where name=$1",[region.trim()]);if(!r){r={id:id()};await db.query("insert into regions(id,name) values($1,$2)",[r.id,region.trim()])}const branch={id:id(),name:name.trim(),city:city.trim(),region:region.trim(),code:req.body.code?.trim()||`BR-${Date.now()}`};await db.query("insert into branches(id,region_id,name,city,code,current_score,current_status,active) values($1,$2,$3,$4,$5,0,'danger',true)",[branch.id,r.id,branch.name,branch.city,branch.code]);await audit(req,"branch.create","branch",branch.id,null,branch);res.status(201).json(branch)});
api.patch("/branches/:id",allow("system_admin","operations_manager"),async(req,res)=>{const before=await one("select * from branches where id=$1",[req.params.id]);if(!before)return res.status(404).json({error:"الفرع غير موجود"});await db.query("update branches set name=coalesce($2,name),city=coalesce($3,city),active=coalesce($4,active) where id=$1",[req.params.id,req.body.name||null,req.body.city||null,typeof req.body.active==="boolean"?req.body.active:null]);await audit(req,"branch.update","branch",req.params.id,before,req.body);res.json({ok:true})});
api.delete("/branches/:id",allow("system_admin"),async(req,res)=>{const before=await one("select * from branches where id=$1",[req.params.id]);if(!before)return res.status(404).json({error:"الفرع غير موجود"});await db.query("update branches set active=false where id=$1",[req.params.id]);await audit(req,"branch.archive","branch",req.params.id,before,{active:false});res.json({ok:true,archived:true})});
api.get("/branches/:id",async(req,res)=>{const branch=await one("select b.*,r.name region from branches b join regions r on r.id=b.region_id where b.id=$1",[req.params.id]);if(!branch)return res.status(404).json({error:"الفرع غير موجود"});const visits=await q(`select v.*,u.full_name supervisor from visits v left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where branch_id=$1 and workflow_state='approved' order by visit_date desc,created_at desc`,[req.params.id]);const health=await branchHealthDetails(req.params.id);res.json({branch,visits,periods:await periods(req.params.id),healthScore:health.score,health,prediction:await prediction(req.params.id),timeline:await branchTimeline(req.params.id),itemTrends:await itemTrends(req.params.id),warnings:await q(`select w.*,u.full_name inspector,r.original_name report_name from branch_warnings w left join supervisors s on s.id=w.supervisor_id left join users u on u.id=s.user_id left join reports r on r.id=w.report_id where w.branch_id=$1 order by w.warning_date desc`,[req.params.id]),observations:await q("select o.* from observations o join visits v on v.id=o.visit_id where v.branch_id=$1 and v.workflow_state='approved' order by o.created_at desc",[req.params.id])})});

api.get("/reports",async(_req,res)=>res.json(await q("select id,original_name,mime_type,size_bytes,status,created_at from reports order by created_at desc")));
api.post("/reports/upload",allow("system_admin","operations_manager","supervisor"),upload.array("reports"),async(req,res)=>{
 const rows=[];for(const f of req.files){const ext=path.extname(f.originalname).toLowerCase(),detected=await fileTypeFromFile(f.path);if(!detected||!validMimeByExtension[ext]?.includes(detected.mime)){await fs.promises.unlink(f.path).catch(()=>{});return res.status(400).json({error:`محتوى الملف لا يطابق نوعه: ${f.originalname}`})}const reportId=id();await db.query("insert into reports(id,original_name,mime_type,size_bytes,storage_path,uploaded_by) values($1,$2,$3,$4,$5,$6)",[reportId,f.originalname,detected.mime,f.size,f.path,req.user.sub]);await audit(req,"report.upload","report",reportId,null,{name:f.originalname,mime:detected.mime});rows.push({id:reportId,name:f.originalname,size:f.size,status:"uploaded"})}res.status(201).json(rows);
});
api.post("/reports/:id/analyze",allow("system_admin","operations_manager","supervisor"),async(req,res)=>{
 const report=await one("select * from reports where id=$1",[req.params.id]);if(!report)return res.status(404).json({error:"التقرير غير موجود"});
 const result=normalizeDraft(await analyzeFile({path:report.storage_path,originalname:report.original_name,mimetype:report.mime_type}));
 const branch=await one("select b.id,b.current_score from branches b where lower(trim(b.name))=lower(trim($1))",[result.branchName]);const inspector=await ensureSupervisor(result.inspectorName);const visitId=id();
 await db.query("insert into visits(id,report_id,branch_id,supervisor_id,visit_date,final_score,previous_score,status,workflow_state,extraction_confidence,draft_data) values($1,$2,$3,$4,$5,$6,$7,$8,'review',95,$9)",[visitId,report.id,branch?.id||null,inspector.id,result.visitDate,result.finalScore,branch?.current_score||null,statusOf(result.finalScore),JSON.stringify(result)]);
 await db.query("update reports set status='analyzed' where id=$1",[report.id]);await db.query("insert into ai_analysis values($1,$2,$3,'v1',$4,$5,$6,$7,$8,now())",[id(),visitId,config.openaiModel,result.summary,JSON.stringify(result.items.filter(i=>i.score>=85)),JSON.stringify(result.items.filter(i=>i.score<70)),result.urgent,JSON.stringify(result)]);
 await audit(req,"report.analyze","visit",visitId,null,{...result,inspectorCreated:!!inspector.created});res.json({visitId,reportId:report.id,confidence:95,data:result,inspector:{id:inspector.id,name:inspector.name,created:!!inspector.created}});
});
api.get("/reports/:id/review",async(req,res)=>{const v=await one("select * from visits where id=$1",[req.params.id]);if(!v)return res.status(404).json({error:"المسودة غير موجودة"});res.json(v)});
api.get("/reports/:id/file",async(req,res)=>{const report=await one("select * from reports where id=$1",[req.params.id]);if(!report||!fs.existsSync(report.storage_path))return res.status(404).json({error:"ملف التقرير غير موجود"});const detected=await fileTypeFromFile(report.storage_path);const contentType=detected?.mime||"text/plain; charset=utf-8";res.setHeader("Content-Type",contentType);res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(report.original_name)}`);res.sendFile(path.resolve(report.storage_path))});
api.put("/reports/:id/review",allow("system_admin","operations_manager","supervisor"),async(req,res)=>{const before=await one("select draft_data from visits where id=$1",[req.params.id]);await db.query("update visits set draft_data=$2,final_score=$3,visit_date=$4,status=$5 where id=$1 and workflow_state='review'",[req.params.id,JSON.stringify(req.body),req.body.finalScore,req.body.visitDate,statusOf(req.body.finalScore)]);await audit(req,"report.review","visit",req.params.id,before?.draft_data,req.body);res.json({ok:true})});
api.post("/reports/:id/approve",allow("system_admin","operations_manager"),async(req,res)=>{
 const v=await one("select * from visits where id=$1 and workflow_state='review'",[req.params.id]);if(!v)return res.status(404).json({error:"المسودة غير موجودة أو معتمدة"});
 const d=normalizeDraft(v.draft_data||{});
 const inspector=await ensureSupervisor(d.inspectorName);
 const result=await transaction(async client=>{
   const branch=await ensureBranch(client,d);
   const previous=await first(client,"select final_score from visits where branch_id=$1 and id<>$2 and workflow_state='approved' order by visit_date desc,created_at desc limit 1",[branch.id,v.id]);
   await client.query("update visits set branch_id=$2,supervisor_id=$3,visit_date=$4,final_score=$5,previous_score=$6,status=$7,workflow_state='approved',approved_by=$8,approved_at=now(),draft_data=$9 where id=$1",[v.id,branch.id,inspector.id,d.visitDate,d.finalScore,previous?.final_score??v.previous_score??null,statusOf(d.finalScore),req.user.sub,JSON.stringify(d)]);
   const latest=await first(client,"select id from visits where branch_id=$1 and workflow_state='approved' order by visit_date desc,created_at desc limit 1",[branch.id]);
   if(latest?.id===v.id)await client.query("update branches set current_score=$2,current_status=$3,city=$4 where id=$1",[branch.id,d.finalScore,statusOf(d.finalScore),d.city]);
   const counters=await persistVisitAnalysis(client,{visit:{...v,branch_id:branch.id,supervisor_id:inspector.id,previous_score:previous?.final_score??v.previous_score??null},branchId:branch.id,supervisorId:inspector.id,draft:d,userId:req.user.sub});
   await client.query("update reports set status='approved' where id=$1",[v.report_id]);
   return {branchId:branch.id,counters};
 });
 const insight=await generateVisitInsight(v.id);clearCache();await audit(req,"report.approve","visit",v.id,{workflow:"review"},{workflow:"approved",...result.counters});res.json({ok:true,branchId:result.branchId,insight,...result.counters});
});

api.get("/observations",async(req,res)=>{const p=reportPeriod(req.query);const rows=await q(`select o.*,oi.name item_name,b.name branch,u.full_name supervisor from observations o join visits v on v.id=o.visit_id join branches b on b.id=v.branch_id left join operational_items oi on oi.id=o.item_id left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where v.workflow_state='approved' and v.visit_date between $1 and $2 order by case when o.state='overdue' then 0 else 1 end,o.created_at desc`,[p.from,p.to]);res.json(rows)});
api.post("/observations",allow("system_admin","operations_manager","supervisor"),async(req,res)=>{const visit=await one("select id from visits where branch_id=$1 and workflow_state='approved' order by visit_date desc limit 1",[req.body.branchId]);if(!visit)return res.status(400).json({error:"لا توجد زيارة معتمدة للفرع"});if(!req.body.body?.trim())return res.status(400).json({error:"نص الملاحظة مطلوب"});const observation={id:id(),visit_id:visit.id,category:req.body.category||"تشغيل عام",body:req.body.body.trim(),severity:req.body.severity||"medium"};await db.query("insert into observations(id,visit_id,category,body,severity,state,due_at) values($1,$2,$3,$4,$5,'new',$6)",[observation.id,observation.visit_id,observation.category,observation.body,observation.severity,req.body.dueAt||null]);await audit(req,"observation.create","observation",observation.id,null,observation);clearCache();res.status(201).json(observation)});
api.patch("/observations/:id",allow("system_admin","operations_manager","branch_manager","supervisor"),async(req,res)=>{const before=await one("select * from observations where id=$1",[req.params.id]);await db.query("update observations set state=coalesce($2,state),assignee_id=coalesce($3,assignee_id),due_at=coalesce($4,due_at),closed_at=case when $2 in ('closed','completed') then now() else closed_at end where id=$1",[req.params.id,req.body.state||null,req.body.assigneeId||null,req.body.dueAt||null]);if(req.body.state&&req.body.state!==before?.state)await db.query("insert into observation_workflow values($1,$2,$3,$4,$5,$6,now())",[id(),req.params.id,before.state,req.body.state,req.user.sub,req.body.comment||null]);clearCache();await audit(req,"observation.update","observation",req.params.id,before,req.body);res.json({ok:true})});
api.get("/observations/:id/workflow",async(req,res)=>res.json(await q(`select w.*,u.full_name actor from observation_workflow w left join users u on u.id=w.actor_id where observation_id=$1 order by created_at`,[req.params.id])));
api.delete("/observations/:id",allow("system_admin"),async(req,res)=>{const before=await one("select * from observations where id=$1",[req.params.id]);if(!before)return res.status(404).json({error:"الملاحظة غير موجودة"});await audit(req,"observation.delete","observation",req.params.id,before,null);await db.query("delete from observations where id=$1",[req.params.id]);clearCache();res.json({ok:true})});
api.post("/observations/:id/images/:kind",allow("system_admin","operations_manager","branch_manager","supervisor"),upload.single("image"),async(req,res)=>{if(!["before","after"].includes(req.params.kind))return res.status(400).json({error:"نوع الصورة غير صحيح"});const o=await one("select o.*,v.branch_id from observations o join visits v on v.id=o.visit_id where o.id=$1",[req.params.id]);if(!o)return res.status(404).json({error:"الملاحظة غير موجودة"});const next=req.params.kind==="before"?"in_progress":"completed";await db.query("update observations set state=$2 where id=$1",[o.id,next]);await db.query("insert into observation_workflow values($1,$2,$3,$4,$5,$6,now())",[id(),o.id,o.state,next,req.user.sub,`رفع صورة ${req.params.kind}`]);await db.query("insert into timeline_events values($1,$2,$3,$4,$5,$6,$7,$8,now())",[id(),o.branch_id,o.visit_id,o.id,`image_${req.params.kind}`,req.params.kind==="before"?"رفع صورة قبل التنفيذ":"رفع صورة بعد التنفيذ",JSON.stringify({path:req.file.path}),req.user.sub]);res.json({ok:true,state:next})});
api.get("/interventions",async(_req,res)=>{const all=await branchList("asc",200),out=[];for(const b of all){const flags=await q(`select o.* from observations o join visits v on v.id=o.visit_id where v.branch_id=$1 and (o.repetition_count>2 or o.severity in ('high','critical') or o.state='overdue')`,[b.id]);if(Number(b.score)<60||Number(b.delta)<-10||flags.length)out.push({...b,healthScore:await branchHealth(b.id),triggers:{lowScore:Number(b.score)<60,sharpDecline:Number(b.delta)<-10,observations:flags}})}res.json(out)});
api.get("/supervisors/analytics",async(req,res)=>{const p=reportPeriod(req.query);res.json(await q(`select s.id,u.full_name name,count(distinct v.id)::int visits,round(avg(distinct v.final_score),1) average,count(o.id)::int observations,round(avg(distinct v.final_score)-(select avg(final_score) from visits where workflow_state='approved' and visit_date between $1 and $2),1) bias,round(avg(v.extraction_confidence),1) report_quality,count(o.id) filter(where o.category in('جودة','منتج'))::int quality_findings,count(o.id) filter(where o.category='سلامة')::int safety_findings,case when avg(v.final_score)<(select avg(final_score) from visits where workflow_state='approved' and visit_date between $1 and $2)-3 then 'strict' when avg(v.final_score)>(select avg(final_score) from visits where workflow_state='approved' and visit_date between $1 and $2)+3 then 'lenient' else 'balanced' end style from visits v join supervisors s on s.id=v.supervisor_id join users u on u.id=s.user_id left join observations o on o.visit_id=v.id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by s.id,u.full_name order by report_quality desc nulls last,visits desc`,[p.from,p.to]))});
api.get("/reports/monthly",async(req,res)=>{const month=req.query.month||new Date().toISOString().slice(0,7);res.json({month,summary:await one(`select count(*)::int visits,round(avg(final_score),1) average,max(final_score) highest,min(final_score) lowest from visits where to_char(visit_date,'YYYY-MM')=$1 and workflow_state='approved'`,[month]),branches:await q(`select b.name,round(avg(v.final_score),1) average,count(*)::int visits from visits v join branches b on b.id=v.branch_id where to_char(v.visit_date,'YYYY-MM')=$1 and v.workflow_state='approved' group by b.id,b.name order by average desc`,[month])})});
api.get("/notifications",async(req,res)=>res.json(await q("select * from notifications where user_id=$1 order by created_at desc",[req.user.sub])));
api.patch("/notifications/:id/read",async(req,res)=>{await db.query("update notifications set read_at=now() where id=$1 and user_id=$2",[req.params.id,req.user.sub]);res.json({ok:true})});
api.patch("/notifications/read-all",async(req,res)=>{await db.query("update notifications set read_at=now() where user_id=$1 and read_at is null",[req.user.sub]);res.json({ok:true})});
api.get("/settings",allow("system_admin","operations_manager"),async(_req,res)=>res.json({items:await q("select * from operational_items order by sort_order"),regions:await q("select * from regions order by name"),users:await q("select u.id,u.full_name,u.email,u.active,r.name role,r.name_ar role_ar from users u join roles r on r.id=u.role_id"),roles:await q("select * from roles")}));
api.post("/settings/reset-production",allow("system_admin"),async(req,res)=>{if(req.body.confirmation!=="مسح بيانات التجربة")return res.status(400).json({error:"عبارة التأكيد غير صحيحة"});const deleted=await resetOperationalData({simulateFailure:config.nodeEnv==="test"&&req.body.simulateFailure===true});await audit(req,"system.production_reset","system","operational_data",deleted,{productionReady:true});res.json({ok:true,deleted,message:"تم مسح بيانات التجربة بالكامل. المنصة الآن فارغة وجاهزة لبدء التشغيل الفعلي من التقارير الحقيقية."})});
api.post("/settings/items",allow("system_admin"),async(req,res)=>{const x={id:id(),...req.body};await db.query("insert into operational_items(id,name,weight,safety_critical,sort_order) values($1,$2,$3,$4,$5)",[x.id,x.name,x.weight||1,!!x.safetyCritical,x.sortOrder||0]);res.status(201).json(x)});
api.patch("/settings/items/:id",allow("system_admin"),async(req,res)=>{const before=await one("select * from operational_items where id=$1",[req.params.id]);if(!before)return res.status(404).json({error:"البند غير موجود"});await db.query("update operational_items set name=coalesce($2,name),weight=coalesce($3,weight),safety_critical=coalesce($4,safety_critical),active=coalesce($5,active) where id=$1",[req.params.id,req.body.name||null,req.body.weight??null,typeof req.body.safetyCritical==="boolean"?req.body.safetyCritical:null,typeof req.body.active==="boolean"?req.body.active:null]);await audit(req,"item.update","operational_item",req.params.id,before,req.body);res.json({ok:true})});
api.delete("/settings/items/:id",allow("system_admin"),async(req,res)=>{const before=await one("select * from operational_items where id=$1",[req.params.id]);if(!before)return res.status(404).json({error:"البند غير موجود"});await db.query("update operational_items set active=false where id=$1",[req.params.id]);await audit(req,"item.archive","operational_item",req.params.id,before,{active:false});res.json({ok:true,archived:true})});
api.get("/exports/:type",async(req,res)=>{const type=req.params.type;if(["branches","observations","warnings","supervisors"].includes(type)){const rows=type==="branches"?await branchList("desc",1000):type==="observations"?await q("select * from observations"):type==="supervisors"?await q(`select u.full_name inspector,count(distinct v.id)::int visits,round(avg(v.final_score),1) average,count(distinct o.id)::int observations,count(distinct w.id)::int warnings from supervisors s join users u on u.id=s.user_id left join visits v on v.supervisor_id=s.id left join observations o on o.visit_id=v.id left join branch_warnings w on w.visit_id=v.id group by s.id,u.full_name order by visits desc`):await q(`select b.name branch,b.city,w.warning_date,u.full_name inspector,w.item_name,w.reason,w.question_number,w.report_number,w.warning_text from branch_warnings w join branches b on b.id=w.branch_id left join supervisors s on s.id=w.supervisor_id left join users u on u.id=s.user_id order by w.warning_date desc`);const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet(type),labels={branch:"الفرع",city:"المدينة",region:"المنطقة",score:"التقييم",status:"الحالة",delta:"التغير",supervisor:"المراقب",visit_date:"تاريخ الزيارة",visits:"الزيارات",inspector:"المراقب",average:"المتوسط",observations:"الملاحظات",warnings:"الإنذارات",warning_date:"تاريخ الإنذار",item_name:"البند",reason:"السبب",question_number:"رقم السؤال",report_number:"رقم التقرير",warning_text:"نص الإنذار",category:"التصنيف",body:"نص الملاحظة",severity:"الخطورة",state:"حالة التنفيذ",repetition_count:"التكرار",due_at:"الاستحقاق",created_at:"تاريخ الإنشاء"};ws.views=[{rightToLeft:true,state:"frozen",ySplit:1}];if(rows.length){ws.columns=Object.keys(rows[0]).map(k=>({header:labels[k]||k,key:k,width:["warning_text","body"].includes(k)?48:22}));ws.addRows(rows);ws.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};ws.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF173866"}};ws.getRow(1).height=24;ws.autoFilter={from:{row:1,column:1},to:{row:rows.length+1,column:Object.keys(rows[0]).length}}}res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename=${type}.xlsx`);await wb.xlsx.write(res);return res.end()}res.status(400).json({error:"نوع التصدير غير مدعوم"})});
api.get("/exports/branch/:id.pdf",async(req,res)=>{const b=await one("select * from branches where id=$1",[req.params.id]);if(!b)return res.status(404).end();res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename=branch-${b.code}.pdf`);const doc=new PDFDocument();doc.pipe(res);doc.fontSize(22).text(`Branch report: ${b.name}`).fontSize(14).text(`Score: ${b.current_score}%`).text(`Status: ${b.current_status}`).text(`Generated: ${new Date().toISOString()}`);doc.end()});
api.get("/exports/monthly/:month.pdf",async(req,res)=>{const data=await one(`select count(*)::int visits,round(avg(final_score),1) average,max(final_score) highest,min(final_score) lowest from visits where to_char(visit_date,'YYYY-MM')=$1 and workflow_state='approved'`,[req.params.month]);res.setHeader("Content-Type","application/pdf");res.setHeader("Content-Disposition",`attachment; filename=monthly-${req.params.month}.pdf`);const doc=new PDFDocument();doc.pipe(res);doc.fontSize(22).text(`Monthly operations report: ${req.params.month}`).fontSize(14).text(`Visits: ${data.visits}`).text(`Average: ${data.average||0}%`).text(`Highest: ${data.highest||0}%`).text(`Lowest: ${data.lowest||0}%`).text(`Generated: ${new Date().toISOString()}`);doc.end()});
async function audit(req,action,entityType,entityId,before,after){await db.query("insert into audit_logs(actor_id,action,entity_type,entity_id,before_data,after_data,ip) values($1,$2,$3,$4,$5,$6,$7)",[req.user.sub,action,entityType,entityId,before?JSON.stringify(before):null,after?JSON.stringify(after):null,req.ip])}
