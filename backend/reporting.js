import PDFDocument from "pdfkit";
import fs from "node:fs";
import OpenAI from "openai";
import { q, one } from "./db.js";
import { config } from "./config.js";

const arDate = value => new Intl.DateTimeFormat("ar-SA",{dateStyle:"medium"}).format(new Date(value));
const n = value => Number(value || 0);
const ltr = value => String(value).replace(/[0-9]/g,d=>"٠١٢٣٤٥٦٧٨٩"[Number(d)]).replace(".", "٫");
const clean = value => String(value || "").toLowerCase().replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/[^\p{L}\p{N}]+/gu," ").trim();

export function reportPeriod(query={}){
  const to = query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : new Date().toISOString().slice(0,10);
  const key = ["1m","3m","6m","1y","custom"].includes(query.period) ? query.period : "3m";
  let from;
  if(key==="custom"){
    if(!query.from||!/^\d{4}-\d{2}-\d{2}$/.test(query.from))throw new Error("حدد تاريخ بداية صحيح للفترة المخصصة");
    from=query.from;
  }
  else {
    const d=new Date(`${to}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth()-(key==="1m"?1:key==="6m"?6:key==="1y"?12:3));
    from=d.toISOString().slice(0,10);
  }
  if(from>to) throw new Error("تاريخ بداية الفترة يجب أن يسبق تاريخ النهاية");
  return {key,from,to,label:key==="1m"?"آخر شهر":key==="3m"?"آخر 3 أشهر":key==="6m"?"آخر 6 أشهر":key==="1y"?"آخر سنة":`من ${arDate(from)} إلى ${arDate(to)}`};
}

function lifecycle(rows,latestVisitByBranch){
  const groups=new Map();
  for(const x of rows){
    const key=`${x.branch_id}|${clean(x.category)}|${clean(x.body)}`;
    const value=groups.get(key)||{branch:x.branch,category:x.category,body:x.body,firstSeen:x.visit_date,lastSeen:x.visit_date,count:0,visitIds:new Set(),inspectors:new Set()};
    value.count++; value.visitIds.add(x.visit_id); if(x.inspector)value.inspectors.add(x.inspector);
    if(x.visit_date<value.firstSeen)value.firstSeen=x.visit_date;
    if(x.visit_date>value.lastSeen)value.lastSeen=x.visit_date;
    groups.set(key,value);
  }
  return [...groups.values()].map(x=>({...x,visits:x.visitIds.size,inspectors:[...x.inspectors],stillRecurring:x.count>1&&x.lastSeen===latestVisitByBranch.get(x.branch),disappeared:x.lastSeen!==latestVisitByBranch.get(x.branch),firstSeen:arDate(x.firstSeen),lastSeen:arDate(x.lastSeen)})).sort((a,b)=>b.count-a.count);
}

function inspectorDifferences(rows){
  const byBranch=new Map();
  for(const x of rows){
    if(!byBranch.has(x.branch_id))byBranch.set(x.branch_id,new Map());
    const visits=byBranch.get(x.branch_id);
    if(!visits.has(x.visit_id))visits.set(x.visit_id,{date:x.visit_date,inspector:x.inspector,branch:x.branch,issues:[]});
    visits.get(x.visit_id).issues.push(x);
  }
  const output=[];
  for(const visits of byBranch.values()){
    const ordered=[...visits.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    for(let i=1;i<ordered.length;i++){
      const previous=ordered[i-1],current=ordered[i];
      const prevKeys=new Set(previous.issues.map(x=>`${clean(x.category)}|${clean(x.body)}`));
      const currentKeys=new Set(current.issues.map(x=>`${clean(x.category)}|${clean(x.body)}`));
      for(const issue of current.issues)if(!prevKeys.has(`${clean(issue.category)}|${clean(issue.body)}`))output.push({branch:current.branch,previousDate:previous.date,currentDate:current.date,type:"new",previousInspector:previous.inspector,currentInspector:current.inspector,category:issue.category,observation:issue.body,analysis:"ظهرت الملاحظة في الزيارة اللاحقة ولم تُسجل في السابقة؛ قد تكون مشكلة جديدة أو مؤشر اختلاف في دقة الرصد ويُنصح بمراجعة التقريرين."});
      for(const issue of previous.issues)if(!currentKeys.has(`${clean(issue.category)}|${clean(issue.body)}`))output.push({branch:current.branch,previousDate:previous.date,currentDate:current.date,type:"resolved",previousInspector:previous.inspector,currentInspector:current.inspector,category:issue.category,observation:issue.body,analysis:"لم تعد الملاحظة موجودة في الزيارة التالية، ويُرجّح أنها عولجت منذ الزيارة السابقة."});
    }
  }
  return output.slice(0,40);
}

const groupCount=(rows,key)=>Object.entries(rows.reduce((a,x)=>{const k=x[key]||"غير مصنف";a[k]=(a[k]||0)+1;return a},{})).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
const pct=value=>Math.max(0,Math.min(100,Math.round(Number(value)||0)));

async function aiNarrative(context,fallback){
  if(!config.openaiKey)return fallback;
  try{
    const client=new OpenAI({apiKey:config.openaiKey});
    const response=await client.responses.create({model:config.openaiModel,input:`أنت محلل عمليات تنفيذي. اكتب بالعربية فقرة دقيقة مناسبة للمدير العام، اعتمادًا فقط على البيانات التالية. وضح ماذا حدث، أسباب التحسن والتراجع، المشاكل والإنذارات المتكررة، أداء المراقبين، الفروع التي تحتاج متابعة، وتوصيات عملية. لا تخترع أرقامًا:\n${JSON.stringify(context)}`});
    return response.output_text||fallback;
  }catch{return fallback}
}

export async function generalManagerData(query={}){
  const period=reportPeriod(query),params=[period.from,period.to];
  const summary=await one(`select count(distinct b.id)::int branches,count(distinct v.id)::int visits,round(avg(v.final_score),1) average,max(v.final_score) highest,min(v.final_score) lowest from visits v join branches b on b.id=v.branch_id where v.workflow_state='approved' and v.visit_date between $1 and $2`,params);
  const branches=await q(`select b.id,b.name,b.city,r.name region,count(v.id)::int visits,round(avg(v.final_score),1) average,(array_agg(v.final_score order by v.visit_date))[1] first_score,(array_agg(v.final_score order by v.visit_date desc))[1] last_score,min(v.visit_date) first_date,max(v.visit_date) last_date from visits v join branches b on b.id=v.branch_id join regions r on r.id=b.region_id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by b.id,b.name,b.city,r.name order by last_score desc`,params);
  for(const x of branches)x.delta=Number((n(x.last_score)-n(x.first_score)).toFixed(1));
  const items=await q(`select oi.id,oi.name,round(avg(vi.score),1) average,(array_agg(vi.score order by v.visit_date))[1] first_score,(array_agg(vi.score order by v.visit_date desc))[1] last_score,count(*)::int samples from visit_items vi join visits v on v.id=vi.visit_id join operational_items oi on oi.id=vi.item_id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by oi.id,oi.name order by average asc`,params);
  const allOperationalItems=await q("select id,name from operational_items where active=true order by sort_order,name");
  for(const item of allOperationalItems)if(!items.some(x=>x.id===item.id))items.push({...item,average:null,first_score:null,last_score:null,samples:0});
  for(const x of items)x.delta=Number((n(x.last_score)-n(x.first_score)).toFixed(1));
  const supervisors=await q(`select s.id,u.full_name name,count(distinct v.id)::int visits,round(avg(v.final_score),1) average,count(distinct o.id)::int observations,count(distinct w.id)::int warnings,count(distinct v.branch_id)::int branches,round(avg(v.final_score-v.previous_score),1) branch_improvement from visits v join supervisors s on s.id=v.supervisor_id join users u on u.id=s.user_id left join observations o on o.visit_id=v.id left join branch_warnings w on w.visit_id=v.id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by s.id,u.full_name order by average desc`,params);
  const observations=await q(`select o.*,v.branch_id,v.visit_date,b.name branch,u.full_name inspector from observations o join visits v on v.id=o.visit_id join branches b on b.id=v.branch_id left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where v.workflow_state='approved' and v.visit_date between $1 and $2 order by v.branch_id,v.visit_date`,params);
  const warnings=await q(`select w.*,b.name branch,b.city,u.full_name inspector,r.original_name report_name from branch_warnings w join branches b on b.id=w.branch_id left join supervisors s on s.id=w.supervisor_id left join users u on u.id=s.user_id left join reports r on r.id=w.report_id where w.warning_date between $1 and $2 order by w.warning_date desc,w.created_at desc`,params);
  const branchItems=await q(`select v.branch_id,b.name branch,oi.id item_id,oi.name item,round(avg(vi.score),1) average,(array_agg(vi.score order by v.visit_date))[1] first_score,(array_agg(vi.score order by v.visit_date desc))[1] last_score from visit_items vi join visits v on v.id=vi.visit_id join branches b on b.id=v.branch_id join operational_items oi on oi.id=vi.item_id where v.workflow_state='approved' and v.visit_date between $1 and $2 group by v.branch_id,b.name,oi.id,oi.name`,params);
  const supervisorBranches=await q(`select distinct u.full_name inspector,b.name branch from visits v join supervisors s on s.id=v.supervisor_id join users u on u.id=s.user_id join branches b on b.id=v.branch_id where v.workflow_state='approved' and v.visit_date between $1 and $2`,params);
  const trend=await q(`select to_char(date_trunc('month',visit_date),'YYYY-MM') period,round(avg(final_score),1) value,count(*)::int visits from visits where workflow_state='approved' and visit_date between $1 and $2 group by 1 order by 1`,params);
  const execution=await one(`select count(*)::int total,count(*) filter(where o.state in('completed','closed'))::int completed,count(*) filter(where o.is_repeated=true or o.repetition_count>1)::int repeated from observations o join visits v on v.id=o.visit_id where v.visit_date between $1 and $2`,params);
  const latestVisitByBranch=new Map(branches.map(x=>[x.name,x.last_date]));
  const lifecycles=lifecycle(observations,latestVisitByBranch);
  const differences=inspectorDifferences(observations);
  const best=branches[0],worst=[...branches].sort((a,b)=>n(a.last_score)-n(b.last_score))[0],bestSupervisor=supervisors[0],worstSupervisor=[...supervisors].sort((a,b)=>n(a.average)-n(b.average))[0];
  const repeated=lifecycles.filter(x=>x.count>1).slice(0,5);
  const observationByCategory=groupCount(observations,"category"),warningByBranch=groupCount(warnings,"branch"),warningByItem=groupCount(warnings,"item_name"),warningByInspector=groupCount(warnings,"inspector"),warningReasons=groupCount(warnings,"reason");
  for(const branch of branches){
    const scores=branchItems.filter(x=>x.branch_id===branch.id).sort((a,b)=>n(b.average)-n(a.average));
    branch.strongestItems=scores.slice(0,3);branch.weakestItems=[...scores].sort((a,b)=>n(a.average)-n(b.average)).slice(0,3);
    branch.observations=observations.filter(x=>x.branch_id===branch.id).length;branch.warnings=warnings.filter(x=>x.branch_id===branch.id).length;
    branch.recommendation=branch.delta<-5?"تدخل تشغيلي ومراجعة أسباب التراجع خلال 7 أيام":n(branch.last_score)<70?"خطة تحسين للبنود الأضعف مع إعادة تقييم":branch.delta>5?"تثبيت التحسن ومشاركة الممارسات الناجحة":"متابعة دورية للبنود الأضعف";
  }
  for(const item of items){
    const related=branchItems.filter(x=>x.item_id===item.id);
    item.observations=observations.filter(x=>clean(x.category).includes(clean(item.name))||clean(x.body).includes(clean(item.name))).length;
    item.warnings=warnings.filter(x=>clean(x.item_name).includes(clean(item.name))||clean(x.warning_text).includes(clean(item.name))).length;
    item.weakestBranches=[...related].sort((a,b)=>n(a.average)-n(b.average)).slice(0,3);
    item.mostImprovedBranches=[...related].map(x=>({...x,delta:n(x.last_score)-n(x.first_score)})).sort((a,b)=>b.delta-a.delta).slice(0,3);
  }
  for(const supervisor of supervisors){
    supervisor.branchNames=supervisorBranches.filter(x=>x.inspector===supervisor.name).map(x=>x.branch);
    const focus=groupCount(observations.filter(x=>x.inspector===supervisor.name),"category");
    supervisor.focusItems=focus.slice(0,3);supervisor.comparison=Number((n(supervisor.average)-n(summary?.average)).toFixed(1));
  }
  const overallDelta=branches.length?Number((branches.reduce((a,x)=>a+x.delta,0)/branches.length).toFixed(1)):0;
  const interventions=branches.filter(x=>n(x.last_score)<60||x.delta<-10||observations.some(o=>o.branch_id===x.id&&(["high","critical"].includes(o.severity)||n(o.repetition_count)>2)));
  const kpis={operationalHealth:pct((n(summary?.average)*.6)+(Math.max(-10,Math.min(10,overallDelta))+10)*2),branchQuality:pct(summary?.average),observationExecution:pct(execution?.total?n(execution.completed)/n(execution.total)*100:100),observationRecurrence:pct(100-(execution?.total?n(execution.repeated)/n(execution.total)*100:0)),warnings:pct(100-Math.min(100,warnings.length/Math.max(1,n(summary?.visits))*100)),supervisorPerformance:pct(supervisors.length?supervisors.reduce((a,x)=>a+n(x.average),0)/supervisors.length:0),movement:pct(50+overallDelta*5)};
  const summaryText=`خلال ${period.label} بلغ متوسط الأداء ${ltr(`${summary?.average||0}%`)} عبر ${ltr(summary?.visits||0)} زيارة، وباتجاه عام ${overallDelta>=0?"متحسن":"متراجع"} بمقدار ${ltr(overallDelta)} نقطة. ${best?`تصدّر ${best.name} بتقييم ${ltr(`${best.last_score}%`)}.`:""} ${worst?`ويحتاج ${worst.name} إلى أولوية متابعة عند ${ltr(`${worst.last_score}%`)}.`:""} سُجلت ${ltr(observations.length)} ملاحظة و${ltr(warnings.length)} إنذار. ${repeated.length?`تتركز الملاحظات المتكررة في ${repeated.map(x=>x.category).join("، ")}.`:"لم تظهر ملاحظات متكررة بارزة."}`;
  const aiContext={period,summary:{...summary,overallDelta,observations:observations.length,warnings:warnings.length,interventions:interventions.map(x=>x.name)},best:branches.slice(0,5).map(x=>({name:x.name,score:x.last_score,delta:x.delta})),weak:[...branches].sort((a,b)=>n(a.last_score)-n(b.last_score)).slice(0,5).map(x=>({name:x.name,score:x.last_score,delta:x.delta})),observationByCategory,warningReasons,supervisors:supervisors.map(x=>({name:x.name,visits:x.visits,average:x.average,comparison:x.comparison}))};
  const executiveSummary=await aiNarrative(aiContext,summaryText);
  return {period,generatedAt:new Date().toISOString(),summary:{...summary,overallDelta,observations:observations.length,warnings:warnings.length,interventions:interventions.length,bestBranch:best?.name||"—",worstBranch:worst?.name||"—",bestSupervisor:bestSupervisor?.name||"—",worstSupervisor:worstSupervisor?.name||"—"},kpis,trend,branches,items,supervisors,observations:{total:observations.length,byCategory:observationByCategory,repeated:lifecycles.filter(x=>x.count>1),new:lifecycles.filter(x=>x.count===1&&!x.disappeared),disappeared:lifecycles.filter(x=>x.disappeared),byBranch:groupCount(observations,"branch"),lifecycles},warnings:{total:warnings.length,records:warnings,byBranch:warningByBranch,byItem:warningByItem,byInspector:warningByInspector,reasons:warningReasons},differences,ai:{executiveSummary,strengths:branches.filter(x=>x.delta>0).slice(0,5).map(x=>`${x.name} (+${x.delta})`),weaknesses:branches.filter(x=>x.delta<0).sort((a,b)=>a.delta-b.delta).slice(0,5).map(x=>`${x.name} (${x.delta})`),recommendations:[worst?`خطة تحسين مركزة للفرع ${worst.name} مع إعادة تقييم خلال 14 يومًا.`:"استمرار المتابعة الدورية.",repeated[0]?`معالجة السبب الجذري لملاحظات ${repeated[0].category} المتكررة.`:"تثبيت الممارسات التشغيلية الجيدة.","معايرة منهج التفتيش بين المراقبين عند ظهور فروق رصد متتابعة."]}};
}

const colors={navy:"#102344",blue:"#2768d7",teal:"#0f9f7f",red:"#d84b57",muted:"#667085",line:"#dce3ee",pale:"#f4f7fb"};
export async function writeGeneralManagerPdf(res,data){
  const doc=new PDFDocument({size:"A4",margin:42,bufferPages:true,info:{Title:`تقرير المدير العام - ${data.period.label}`,Author:"منصة رصد"}});
  const font="/System/Library/Fonts/Supplemental/Arial.ttf";
  if(fs.existsSync(font))doc.registerFont("Arabic",font).font("Arabic");
  doc.pipe(res);
  const pageWidth=doc.page.width-84;
  const rtl=(text,x,y,width=pageWidth,opts={})=>doc.text(String(text??""),x,y,{width,align:"right",features:["rtla"],...opts});
  const header=title=>{doc.fillColor(colors.navy).rect(0,0,doc.page.width,78).fill();doc.fillColor("white").fontSize(10).text("RASED | OPERATIONAL INTELLIGENCE",42,22);rtl(title,42,42,pageWidth);doc.fillColor(colors.navy);};
  const section=title=>{if(doc.y>700)doc.addPage();doc.moveDown(.8).fillColor(colors.navy).fontSize(16);rtl(title,42,doc.y,pageWidth);doc.moveDown(.6).strokeColor(colors.line).moveTo(42,doc.y).lineTo(553,doc.y).stroke();doc.moveDown(.6);};
  const table=(headers,rows,widths,rowH=25)=>{const startX=42;let y=doc.y;const drawRow=(cells,head=false)=>{if(y+rowH>758){doc.addPage();y=50}let x=startX;cells.forEach((cell,i)=>{doc.fillColor(head?colors.navy:"white").rect(x,y,widths[i],rowH).fill();doc.strokeColor(colors.line).rect(x,y,widths[i],rowH).stroke();doc.fillColor(head?"white":colors.navy).fontSize(head?9:8).text(String(cell??"—"),x+4,y+6,{width:widths[i]-8,height:rowH-8,align:"center",features:["rtla"],ellipsis:true});x+=widths[i]});y+=rowH};drawRow(headers,true);rows.forEach(r=>drawRow(r));doc.y=y};
  const barChart=(title,rows,valueKey="value",labelKey="name",color=colors.blue)=>{if(doc.y+48+Math.min(10,rows.length)*20>780)doc.addPage();section(title);const max=Math.max(1,...rows.map(x=>n(x[valueKey])));rows.slice(0,10).forEach(x=>{if(doc.y>770)doc.addPage();const y=doc.y;doc.fillColor(colors.muted).fontSize(8).text(String(x[labelKey]??"—"),42,y,{width:145,align:"right",features:["rtla"],ellipsis:true});doc.roundedRect(195,y,300,11,5).fill(colors.pale);doc.roundedRect(195,y,300*n(x[valueKey])/max,11,5).fill(color);doc.fillColor(colors.navy).text(String(x[valueKey]??0),503,y,{width:50,align:"center"});doc.moveDown(1.15)})};
  header("التقرير التنفيذي للمدير العام");
  doc.moveDown(5).fillColor(colors.navy).fontSize(28);rtl("تحليل أداء الفروع التشغيلي",42,120,pageWidth);
  doc.fillColor(colors.blue).fontSize(16);rtl(data.period.label,42,165,pageWidth);
  doc.fillColor(colors.muted).fontSize(11);rtl(`تاريخ الإصدار: ${arDate(data.generatedAt)}`,42,195,pageWidth);
  doc.roundedRect(42,245,pageWidth,185,12).fill(colors.pale);
  doc.fillColor(colors.navy).fontSize(18);rtl("ملخص تنفيذي",62,270,pageWidth-40);
  doc.fillColor(colors.muted).fontSize(12);rtl(data.ai.executiveSummary,62,310,pageWidth-40,{lineGap:8});
  doc.fillColor(colors.teal).fontSize(11);rtl("تقرير ديناميكي مبني حصريًا على الفترة المختارة وبيانات الزيارات المعتمدة.",62,395,pageWidth-40);
  doc.addPage();header("1. الملخص التنفيذي ومؤشرات الأداء");doc.y=105;
  table(["المؤشر","القيمة"],[["الفترة",data.period.label],["عدد الفروع",data.summary.branches],["عدد الزيارات",data.summary.visits],["متوسط التقييم",`${data.summary.average||0}%`],["التحسن / التراجع",data.summary.overallDelta],["الملاحظات",data.summary.observations],["الإنذارات",data.summary.warnings],["تحتاج تدخل",data.summary.interventions],["أفضل فرع",data.summary.bestBranch],["أضعف فرع",data.summary.worstBranch]],[300,211]);
  section("مؤشرات الأداء الموحدة");
  table(["المؤشر","الدرجة من 100"],[["صحة التشغيل",data.kpis.operationalHealth],["جودة الفروع",data.kpis.branchQuality],["تنفيذ الملاحظات",data.kpis.observationExecution],["انخفاض تكرار الملاحظات",data.kpis.observationRecurrence],["انخفاض الإنذارات",data.kpis.warnings],["أداء المراقبين",data.kpis.supervisorPerformance],["التحسن والتراجع",data.kpis.movement]],[300,211]);
  barChart("اتجاه التقييم العام",data.trend,"value","period");
  doc.addPage();header("2. التحليل الكامل للفروع");doc.y=105;
  for(const branch of data.branches){
    section(`${branch.name} - ${branch.city}`);
    table(["الزيارات","المتوسط","أول تقييم","آخر تقييم","التغير","الملاحظات","الإنذارات"],[[branch.visits,`${branch.average}%`,`${branch.first_score}%`,`${branch.last_score}%`,branch.delta,branch.observations,branch.warnings]],[65,75,75,75,65,78,78]);
    doc.fillColor(colors.teal).fontSize(9);rtl(`أقوى البنود: ${branch.strongestItems.map(x=>`${x.item} (${ltr(`${x.average}%`)})`).join("، ")||"لا توجد بيانات"}`,42,doc.y+8,pageWidth);
    doc.fillColor(colors.red).fontSize(9);rtl(`أضعف البنود: ${branch.weakestItems.map(x=>`${x.item} (${ltr(`${x.average}%`)})`).join("، ")||"لا توجد بيانات"}`,42,doc.y+25,pageWidth);
    doc.fillColor(colors.muted).fontSize(9);rtl(`التوصية: ${branch.recommendation}`,42,doc.y+42,pageWidth);doc.moveDown(4);
  }
  doc.addPage();header("3. تحليل البنود التشغيلية");doc.y=105;
  table(["البند","المتوسط","التغير","الملاحظات","الإنذارات","أضعف الفروع"],data.items.map(x=>[x.name,`${x.average}%`,x.delta,x.observations,x.warnings,x.weakestBranches.map(b=>b.branch).join("، ")]),[145,65,60,72,65,104],30);
  barChart("ترتيب البنود حسب المتوسط",data.items.map(x=>({name:x.name,value:x.average})));
  doc.addPage();header("4. تحليل الملاحظات");doc.y=105;
  table(["الإجمالي","المتكررة","الجديدة","ظهرت ثم اختفت","فروق الرصد"],[[data.observations.total,data.observations.repeated.length,data.observations.new.length,data.observations.disappeared.length,data.differences.filter(x=>x.type==="new").length]],[100,100,100,111,100]);
  barChart("الملاحظات حسب التصنيف",data.observations.byCategory,"count");
  section("دورة حياة الملاحظات");
  table(["الفرع / الملاحظة","أول ظهور","آخر ظهور","التكرار","الحالة"],data.observations.lifecycles.map(x=>[`${x.branch}: ${x.body}`,x.firstSeen,x.lastSeen,x.count,x.stillRecurring?"مستمرة":x.disappeared?"اختفت":"جديدة"]),[235,82,82,50,62],30);
  doc.addPage();header("5. سجل الإنذارات وتحليله");doc.y=105;
  barChart("الإنذارات حسب البند",data.warnings.byItem,"count", "name",colors.red);
  section("جميع الإنذارات كما وردت في التقارير");
  table(["الفرع","التاريخ","المراقب","البند","رقم التقرير","نص الإنذار"],data.warnings.records.map(x=>[x.branch,arDate(x.warning_date),x.inspector,x.item_name,x.report_number||x.report_name,x.warning_text]),[80,72,80,76,85,118],38);
  section("أكثر أسباب الإنذارات تكرارًا");
  table(["السبب","العدد"],data.warnings.reasons.map(x=>[x.name,x.count]),[411,100]);
  doc.addPage();header("6. تحليل أداء المراقبين");doc.y=105;
  table(["المراقب","الزيارات","الفروع","المتوسط","الملاحظات","الإنذارات","مقارنة بالعام"],data.supervisors.map(x=>[x.name,x.visits,x.branches,`${x.average}%`,x.observations,x.warnings,x.comparison]),[123,55,55,66,72,65,75],30);
  barChart("أداء المراقبين",data.supervisors.map(x=>({name:x.name,value:x.average})));
  section("أكثر البنود التي يركز عليها كل مراقب");
  table(["المراقب","البنود الأكثر رصدًا"],data.supervisors.map(x=>[x.name,x.focusItems.map(i=>`${i.name} (${i.count})`).join("، ")||"لا توجد ملاحظات"]),[150,361],32);
  doc.addPage();header("7. مقارنة دقة رصد المراقبين");doc.y=105;
  table(["الفرع","المراقب الأول","المراقب الثاني","تاريخا الزيارتين","البند","الملاحظة"],data.differences.filter(x=>x.type==="new").map(x=>[x.branch,x.previousInspector,x.currentInspector,`${arDate(x.previousDate)} / ${arDate(x.currentDate)}`,x.category,x.observation]),[75,75,75,95,70,121],40);
  section("تحليل النظام");
  data.differences.filter(x=>x.type==="new").forEach(x=>{doc.fillColor(colors.red).fontSize(9);rtl(`${x.branch}: ${x.analysis}`,42,doc.y,pageWidth);doc.moveDown(1.4)});
  doc.addPage();header("8. التحليل الذكي والتوصيات");doc.y=110;
  section("الوضع التشغيلي العام");doc.fillColor(colors.muted).fontSize(12);rtl(data.ai.executiveSummary,42,doc.y,pageWidth,{lineGap:7});doc.moveDown(4);
  section("نقاط القوة");data.ai.strengths.forEach(x=>{doc.fillColor(colors.teal).fontSize(11);rtl(`• ${x}`,42,doc.y,pageWidth);doc.moveDown(.7)});
  section("نقاط الضعف");data.ai.weaknesses.forEach(x=>{doc.fillColor(colors.red).fontSize(11);rtl(`• ${x}`,42,doc.y,pageWidth);doc.moveDown(.7)});
  section("التوصيات العملية للإدارة العامة");data.ai.recommendations.forEach((x,i)=>{doc.fillColor(colors.navy).fontSize(11);rtl(`${i+1}. ${x}`,42,doc.y,pageWidth);doc.moveDown(1)});
  barChart("أفضل الفروع",data.branches.slice(0,10).map(x=>({name:x.name,value:x.last_score})),"value","name",colors.teal);
  barChart("أضعف الفروع",[...data.branches].sort((a,b)=>n(a.last_score)-n(b.last_score)).slice(0,10).map(x=>({name:x.name,value:x.last_score})),"value","name",colors.red);
  const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.fillColor(colors.muted).fontSize(8).text(`RASED - Confidential | ${i+1} / ${pages.count}`,42,800,{width:pageWidth,align:"center"})}
  doc.end();
}
