import OpenAI from "openai";
import { config } from "./config.js";
import { q,one,id,db } from "./db.js";
import { branchHealth } from "./analytics.js";

const cache=new Map();
export async function cached(key,ttl,fn){
  const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;
  const value=await fn();cache.set(key,{value,expires:Date.now()+ttl});return value;
}
export function clearCache(){cache.clear()}

export async function executiveDashboard(){
  return cached("executive",30000,async()=>{
    const company=await one(`select round(avg(current_score),1) average,count(*)::int branches,count(*) filter(where current_score>=90)::int excellent,count(*) filter(where current_score<60)::int critical from branches where active=true`);
    const movement=await one(`select count(*) filter(where final_score>previous_score)::int improved,count(*) filter(where final_score<previous_score)::int declined,round(avg(final_score-previous_score),1) monthly_improvement from (select distinct on(branch_id) branch_id,final_score,previous_score from visits where workflow_state='approved' order by branch_id,visit_date desc) x`);
    const completion=await one(`select count(*)::int total,count(*) filter(where state in('completed','closed'))::int completed,round(100.0*count(*) filter(where state in('completed','closed'))/nullif(count(*),0),1) completion_rate from observations`);
    const regions=await q(`select r.name,round(avg(b.current_score),1) score,count(*)::int branches from branches b join regions r on r.id=b.region_id group by r.id,r.name order by score desc`);
    const issues=await q(`select category,count(*)::int count,count(*) filter(where severity in('high','critical'))::int critical from observations group by category order by count desc limit 8`);
    const supervisors=await q(`select u.full_name name,count(distinct v.id)::int visits,round(avg(v.final_score),1) average,round(avg(v.extraction_confidence),1) accuracy,count(o.id)::int observations from supervisors s join users u on u.id=s.user_id left join visits v on v.supervisor_id=s.id and v.workflow_state='approved' left join observations o on o.visit_id=v.id group by s.id,u.full_name order by accuracy desc nulls last,visits desc`);
    const branches=await q(`select b.id,b.name,b.city,r.name region,b.current_score score,b.current_status status,coalesce((select final_score-previous_score from visits where branch_id=b.id order by visit_date desc limit 1),0) delta from branches b join regions r on r.id=b.region_id order by b.current_score desc`);
    const healthScores=[];for(const b of branches)healthScores.push(await branchHealth(b.id));
    const overallHealth=Math.round(healthScores.reduce((a,b)=>a+b,0)/Math.max(1,healthScores.length));
    const annual=await one(`select round(avg(final_score) filter(where visit_date>=current_date-interval '1 year')-avg(final_score) filter(where visit_date<current_date-interval '1 year' and visit_date>=current_date-interval '2 years'),1) annual_improvement from visits where workflow_state='approved'`);
    const data={overallHealth,company,movement,completion,regions,issues,supervisors,top:branches.slice(0,10),bottom:[...branches].reverse().slice(0,10),annualImprovement:Number(annual?.annual_improvement||0)};
    data.aiSummary=await executiveSummary(data);return data;
  });
}
async function executiveSummary(data){
  const fallback=`بلغت الصحة التشغيلية العامة ${data.overallHealth} من 100 بمتوسط أداء ${data.company.average}%. تحسن ${data.movement.improved} فرعًا وتراجع ${data.movement.declined} فرعًا. أكثر المشكلات تكرارًا هي ${data.issues.slice(0,3).map(x=>x.category).join("، ")}. الفروع ذات الأولوية خلال أسبوع: ${data.bottom.filter(x=>Number(x.score)<70||Number(x.delta)<-5).slice(0,4).map(x=>x.name).join("، ")||"لا يوجد"}. الاتجاه المتوقع للشهر القادم ${Number(data.movement.monthly_improvement)>=0?"إيجابي مع استمرار المتابعة":"يحتاج تدخلًا مركزًا"}.`;
  if(!config.openaiKey)return fallback;
  const client=new OpenAI({apiKey:config.openaiKey});const r=await client.responses.create({model:config.openaiModel,input:`اكتب ملخصًا تنفيذيًا عربيًا موجزًا وعمليًا لهذه المؤشرات التشغيلية مع تفسير الاتجاه وتوقع الشهر القادم:\n${JSON.stringify(data)}`});return r.output_text;
}

export async function cityHeatmap(){
  return q(`select b.city,r.name region,round(avg(b.current_score),1) score,count(*)::int branches,json_agg(json_build_object('id',b.id,'name',b.name,'score',b.current_score,'status',b.current_status) order by b.current_score desc) branches_list from branches b join regions r on r.id=b.region_id where b.active=true group by b.city,r.name order by score desc`);
}
export async function branchTimeline(branchId){
  const visits=await q(`select v.id,'visit' type,'زيارة فرع' title,v.visit_date event_date,u.full_name actor,json_build_object('score',v.final_score,'status',v.status,'previous',v.previous_score) details from visits v left join supervisors s on s.id=v.supervisor_id left join users u on u.id=s.user_id where v.branch_id=$1 and v.workflow_state='approved'`,[branchId]);
  const obs=await q(`select o.id,'observation' type,case when o.state in('closed','completed') then 'إغلاق ملاحظة' else 'اكتشاف ملاحظة' end title,coalesce(o.closed_at,o.created_at) event_date,u.full_name actor,json_build_object('body',o.body,'severity',o.severity,'state',o.state,'category',o.category) details from observations o join visits v on v.id=o.visit_id left join users u on u.id=o.assignee_id where v.branch_id=$1`,[branchId]);
  const events=await q(`select id,event_type type,title,created_at event_date,null actor,details from timeline_events where branch_id=$1`,[branchId]);
  return [...visits,...obs,...events].sort((a,b)=>new Date(b.event_date)-new Date(a.event_date));
}
export async function itemTrends(branchId){
  return q(`select oi.name,round(avg(vi.score) filter(where v.visit_date>=current_date-interval '1 month'),1) as month_score,round(avg(vi.score) filter(where v.visit_date>=current_date-interval '3 months'),1) as three_months,round(avg(vi.score) filter(where v.visit_date>=current_date-interval '6 months'),1) as six_months,round(avg(vi.score) filter(where v.visit_date>=current_date-interval '1 year'),1) as year_score,json_agg(json_build_object('date',v.visit_date,'score',vi.score) order by v.visit_date) history from visit_items vi join operational_items oi on oi.id=vi.item_id join visits v on v.id=vi.visit_id where v.branch_id=$1 and v.workflow_state='approved' group by oi.id,oi.name order by year_score desc nulls last`,[branchId]);
}
export async function prediction(branchId){
  const visits=await q(`select final_score,visit_date from visits where branch_id=$1 and workflow_state='approved' order by visit_date desc limit 8`,[branchId]);
  const values=[...visits].reverse().map(v=>Number(v.final_score));if(values.length<2)return {predicted:values[0]||0,direction:"stable",confidence:40};
  const n=values.length,xm=(n-1)/2,ym=values.reduce((a,b)=>a+b,0)/n,slope=values.reduce((a,y,x)=>a+(x-xm)*(y-ym),0)/values.reduce((a,_,x)=>a+(x-xm)**2,0);
  const predicted=Math.max(0,Math.min(100,Math.round((values.at(-1)+slope)*10)/10));
  return {predicted,direction:slope>1?"up":slope<-1?"down":"stable",change:Math.round(slope*10)/10,confidence:Math.min(92,55+n*5),message:slope>1?`مرشح للوصول إلى ${predicted}% خلال شهر`:slope<-1?`يوجد احتمال تراجع إلى ${predicted}% خلال شهر`:`متوقع الاستقرار حول ${predicted}%`};
}

export async function portfolioForecast(){
  return cached("portfolio-forecast",60000,async()=>{
    const branches=await q("select id,name,city,current_score score from branches where active=true");
    const results=[];for(const branch of branches){const p=await prediction(branch.id),health=await branchHealth(branch.id);const reason=p.direction==="up"?`اتجاه صاعد بمعدل ${p.change} نقطة لكل زيارة`:p.direction==="down"?`اتجاه هابط بمعدل ${Math.abs(p.change)} نقطة لكل زيارة`:"استقرار التقييمات الأخيرة";results.push({...branch,...p,health,reason,category:p.predicted>=90?"above90":p.predicted<60?"risk":p.direction==="up"?"improving":p.direction==="down"?"declining":"stable"})}return results.sort((a,b)=>b.confidence-a.confidence);
  });
}

export async function regionalHealth(){
  return cached("regional-health",60000,async()=>{
    const regions=await q("select r.id,r.name from regions r order by r.name"),out=[];
    for(const region of regions){const branches=await q("select id,current_score from branches where region_id=$1 and active=true",[region.id]);const scores=[];for(const b of branches)scores.push(await branchHealth(b.id));const trend=await one(`select round(avg(v.final_score-v.previous_score),1) trend from visits v join branches b on b.id=v.branch_id where b.region_id=$1 and v.workflow_state='approved' and v.visit_date>=current_date-interval '3 months'`,[region.id]);out.push({...region,branches:branches.length,health:Math.round(scores.reduce((a,b)=>a+b,0)/Math.max(1,scores.length)),average:Math.round(branches.reduce((a,b)=>a+Number(b.current_score),0)/Math.max(1,branches.length)*10)/10,trend:Number(trend?.trend||0)})}return out.sort((a,b)=>b.health-a.health);
  });
}

export async function supervisorHealth(){
  return cached("supervisor-health",60000,async()=>{
    const rows=await q(`select s.id,u.full_name name,count(distinct v.id)::int visits,coalesce(round(avg(v.extraction_confidence),1),0) report_quality,coalesce(round(avg(v.final_score),1),0) branch_average,count(o.id) filter(where o.severity in('high','critical'))::int risks,count(o.id)::int findings,coalesce(round(abs(avg(v.final_score)-(select avg(final_score) from visits where workflow_state='approved')),1),0) deviation from supervisors s join users u on u.id=s.user_id left join visits v on v.supervisor_id=s.id and v.workflow_state='approved' left join observations o on o.visit_id=v.id group by s.id,u.full_name`);
    return rows.map(x=>{
      const score=Number(x.report_quality)*.35+Math.min(100,Number(x.visits)*4)*.2+Math.min(100,Number(x.findings)*5)*.15+Math.min(100,Number(x.risks)*15)*.15+Math.max(0,100-Number(x.deviation)*8)*.15;
      return {...x,health:Math.round(Math.max(0,Math.min(100,score)))};
    }).sort((a,b)=>b.health-a.health);
  });
}

export async function smartAlerts(){
  const forecasts=await portfolioForecast(),alerts=[];
  for(const f of forecasts){if(f.health<60)alerts.push({type:"health",severity:"critical",title:`انخفاض صحة ${f.name}`,body:`مؤشر الصحة ${f.health}/100`,entityId:f.id});if(f.category==="risk")alerts.push({type:"forecast",severity:"critical",title:`${f.name} مرشح لدخول الخطر`,body:f.reason,entityId:f.id});if(f.direction==="down")alerts.push({type:"decline",severity:"high",title:`اتجاه هابط في ${f.name}`,body:f.reason,entityId:f.id})}
  const repeated=await q(`select b.id,b.name,o.category,o.repetition_count from observations o join visits v on v.id=o.visit_id join branches b on b.id=v.branch_id where o.repetition_count>2 order by o.repetition_count desc`);
  for(const x of repeated)alerts.push({type:"repeat",severity:"high",title:`تكرار ${x.category} في ${x.name}`,body:`تكررت ${x.repetition_count} مرات`,entityId:x.id});
  const overdue=await q(`select b.id,b.name,count(*)::int count from observations o join visits v on v.id=o.visit_id join branches b on b.id=v.branch_id where o.state='overdue' or(o.due_at<now() and o.state not in('closed','completed')) group by b.id,b.name`);
  for(const x of overdue)alerts.push({type:"overdue",severity:"high",title:`تأخر التنفيذ في ${x.name}`,body:`${x.count} ملاحظات متأخرة`,entityId:x.id});
  const cityDrops=await q(`select b.city,round(avg(v.final_score) filter(where v.visit_date>=current_date-interval '30 days')-avg(v.final_score) filter(where v.visit_date<current_date-interval '30 days' and v.visit_date>=current_date-interval '60 days'),1) delta from visits v join branches b on b.id=v.branch_id where v.workflow_state='approved' group by b.city having avg(v.final_score) filter(where v.visit_date>=current_date-interval '30 days')<avg(v.final_score) filter(where v.visit_date<current_date-interval '30 days' and v.visit_date>=current_date-interval '60 days')-5`);
  for(const x of cityDrops)alerts.push({type:"city_decline",severity:"critical",title:`انخفاض أداء مدينة ${x.city}`,body:`تراجع متوسط المدينة ${Math.abs(Number(x.delta))} نقاط`});
  const itemDrops=await q(`select b.id,b.name,oi.name item,vi.score,vi.previous_score from visit_items vi join visits v on v.id=vi.visit_id join branches b on b.id=v.branch_id join operational_items oi on oi.id=vi.item_id where vi.previous_score is not null and vi.score-vi.previous_score<-10 order by vi.score-vi.previous_score limit 10`);
  for(const x of itemDrops)alerts.push({type:"item_decline",severity:"high",title:`انخفاض بند ${x.item} في ${x.name}`,body:`من ${x.previous_score}% إلى ${x.score}%`,entityId:x.id});
  const supervisorVariance=await q(`select b.id,b.name,max(v.final_score)-min(v.final_score) spread from visits v join branches b on b.id=v.branch_id where v.visit_date>=current_date-interval '30 days' group by b.id,b.name having max(v.final_score)-min(v.final_score)>15`);
  for(const x of supervisorVariance)alerts.push({type:"supervisor_variance",severity:"high",title:`اختلاف تقييم المراقبين في ${x.name}`,body:`فارق ${x.spread} نقطة`,entityId:x.id});
  return alerts.slice(0,30);
}

export async function commandCenter(){
  return cached("command-center",30000,async()=>{
    const [executive,regions,supervisors,forecasts,alerts,cities]=await Promise.all([executiveDashboard(),regionalHealth(),supervisorHealth(),portfolioForecast(),smartAlerts(),cityHeatmap()]);
    const opportunities=forecasts.filter(x=>x.direction==="up"&&x.predicted<90).slice(0,6).map(x=>({branch:x.name,title:`تسريع وصول ${x.name} إلى التميز`,impact:`متوقع ${x.predicted}%`,reason:x.reason}));
    return {generatedAt:new Date().toISOString(),company:{health:executive.overallHealth,performance:Number(executive.company.average),risk:alerts.filter(x=>x.severity==="critical").length,growth:Number(executive.movement.monthly_improvement||0),branches:Number(executive.company.branches)},regions,cities,branches:{top:executive.top,bottom:executive.bottom},supervisors,forecasts:{improving:forecasts.filter(x=>x.category==="improving"),declining:forecasts.filter(x=>x.category==="declining"),risk:forecasts.filter(x=>x.category==="risk"),above90:forecasts.filter(x=>x.category==="above90")},risks:alerts,opportunities,aiSummary:executive.aiSummary};
  });
}

export async function fullBranchComparison(a,b){
  const basic=await compare("branch",a,b);
  async function details(branchId){const branch=await one("select id,name,city,current_score score,current_status status from branches where id=$1",[branchId]);const visits=await q("select visit_date,final_score,previous_score from visits where branch_id=$1 and workflow_state='approved' order by visit_date",[branchId]);const items=await itemTrends(branchId);const observations=await q(`select category,severity,state,body,repetition_count from observations o join visits v on v.id=o.visit_id where v.branch_id=$1 order by o.created_at desc`,[branchId]);const health=await branchHealth(branchId),forecast=await prediction(branchId);return {branch,visits,items,observations,health,forecast,strengths:items.filter(x=>Number(x.year_score)>=85).slice(0,5),weaknesses:items.filter(x=>Number(x.year_score)<70).slice(0,5)}}
  return {...basic,leftDetails:await details(a),rightDetails:await details(b),recommendation:`ركز على نقل ممارسات ${basic.winner} في البنود الأعلى أداءً، مع خطة معالجة للبنود الأقل من 70%.`};
}

export async function generateVisitInsight(visitId){
  const visit=await one(`select v.*,b.name branch_name from visits v join branches b on b.id=v.branch_id where v.id=$1`,[visitId]);if(!visit)return null;
  const observations=await q("select category,severity,is_repeated,repetition_count from observations where visit_id=$1",[visitId]),change=Number(visit.final_score)-Number(visit.previous_score||visit.final_score),forecast=await prediction(visit.branch_id);
  const structured={whatChanged:`${change>=0?"تحسن":"تراجع"} التقييم بمقدار ${Math.abs(change).toFixed(1)} نقطة`,whyChanged:observations.length?`رُصدت ${observations.length} ملاحظات، أبرزها ${observations.slice(0,3).map(x=>x.category).join("، ")}`:"لا توجد ملاحظات جديدة مؤثرة",isNormal:Math.abs(change)<=5,repeated:observations.some(x=>x.is_repeated||Number(x.repetition_count)>1),managementIntervention:change<-10||observations.some(x=>["high","critical"].includes(x.severity)),continuationImpact:forecast.message};
  let summary=`${structured.whatChanged}. ${structured.whyChanged}. ${structured.managementIntervention?"يوصى بتدخل الإدارة.":"تكفي المتابعة التشغيلية المعتادة."} ${structured.continuationImpact}`;
  if(config.openaiKey){const client=new OpenAI({apiKey:config.openaiKey});const r=await client.responses.create({model:config.openaiModel,input:`حلل الزيارة التالية بالعربية في فقرة تنفيذية قصيرة، دون اختلاق بيانات: ${JSON.stringify({visit,observations,structured})}`});summary=r.output_text}
  await db.query("insert into ai_analysis values($1,$2,$3,'v3',$4,$5,$6,$7,$8,now())",[id(),visitId,config.openaiKey?config.openaiModel:"deterministic-v3",summary,JSON.stringify([]),JSON.stringify([]),structured.managementIntervention,JSON.stringify(structured)]);return {summary,...structured};
}
export async function compare(kind,a,b){
  const allowed={branch:["branches","id"],city:["branches","city"],region:["regions","id"],supervisor:["supervisors","id"]};if(!allowed[kind])throw new Error("نوع مقارنة غير مدعوم");
  async function metric(value){if(kind==="branch")return one(`select b.name label,round(avg(v.final_score),1) average,count(v.id)::int visits,max(v.final_score) highest,min(v.final_score) lowest from branches b left join visits v on v.branch_id=b.id and v.workflow_state='approved' where b.id=$1 group by b.id,b.name`,[value]);if(kind==="city")return one(`select b.city label,round(avg(v.final_score),1) average,count(v.id)::int visits,max(v.final_score) highest,min(v.final_score) lowest from branches b left join visits v on v.branch_id=b.id where b.city=$1 group by b.city`,[value]);if(kind==="region")return one(`select r.name label,round(avg(v.final_score),1) average,count(v.id)::int visits,max(v.final_score) highest,min(v.final_score) lowest from regions r join branches b on b.region_id=r.id left join visits v on v.branch_id=b.id where r.id=$1 group by r.id,r.name`,[value]);return one(`select u.full_name label,round(avg(v.final_score),1) average,count(v.id)::int visits,max(v.final_score) highest,min(v.final_score) lowest from supervisors s join users u on u.id=s.user_id left join visits v on v.supervisor_id=s.id where s.id=$1 group by s.id,u.full_name`,[value])}
  const left=await metric(a),right=await metric(b);return {left,right,difference:Number(left?.average||0)-Number(right?.average||0),winner:Number(left?.average||0)>=Number(right?.average||0)?left?.label:right?.label};
}
export async function askAssistant(userId,question){
  const context={executive:await executiveDashboard(),matches:await q(`select b.name,b.city,r.name region,b.current_score score,b.current_status status from branches b join regions r on r.id=b.region_id where b.name like $1 or b.city like $1 or r.name like $1 limit 12`,[`%${question.replace(/[؟?]/g,"").split(" ").filter(x=>x.length>2).at(-1)||""}%`]),issues:await q(`select category,count(*)::int count from observations group by category order by count desc limit 8`)};
  let answer;if(config.openaiKey){const client=new OpenAI({apiKey:config.openaiKey});const r=await client.responses.create({model:config.openaiModel,input:`أنت مساعد رصد التشغيلي. أجب بالعربية اعتمادًا فقط على البيانات التالية، واذكر الأرقام بوضوح. السؤال: ${question}\nالبيانات:${JSON.stringify(context)}`});answer=r.output_text}else{answer=`استنادًا إلى بيانات رَصْد: متوسط الشركة ${context.executive.company.average}% والصحة التشغيلية ${context.executive.overallHealth}/100. ${context.matches.length?`النتائج المرتبطة بسؤالك: ${context.matches.map(x=>`${x.name} (${x.score}%)`).join("، ")}.`:`أكثر المشكلات تكرارًا: ${context.issues.slice(0,3).map(x=>`${x.category} (${x.count})`).join("، ")}.`}`}
  await db.query("insert into ai_conversations values($1,$2,$3,$4,$5,$6,now())",[id(),userId,question,answer,JSON.stringify(context),config.openaiKey?config.openaiModel:"deterministic"]);return {answer,sources:{branches:context.matches.length,generatedAt:new Date().toISOString()}};
}
