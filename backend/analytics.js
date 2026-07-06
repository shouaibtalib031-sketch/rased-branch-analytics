import { q,one } from "./db.js";

export async function branchHealth(branchId){
  return (await branchHealthDetails(branchId)).score;
}
export async function branchHealthDetails(branchId){
  const visits=await q("select final_score,visit_date from visits where branch_id=$1 and workflow_state='approved' order by visit_date desc limit 12",[branchId]);
  const obs=await q("select o.severity,o.state,o.repetition_count,o.due_at,o.created_at,o.closed_at from observations o join visits v on v.id=o.visit_id where v.branch_id=$1",[branchId]);
  if(!visits.length)return {score:0,classification:"critical",components:{}};
  const latest=Number(visits[0].final_score),trend=visits[1]?latest-Number(visits[1].final_score):0;
  const recent=visits.slice(0,6).map(v=>Number(v.final_score)),mean=recent.reduce((a,b)=>a+b,0)/recent.length;
  const variance=recent.reduce((a,b)=>a+(b-mean)**2,0)/recent.length;
  const closed=obs.filter(o=>["closed","completed"].includes(o.state)),completion=obs.length?closed.length/obs.length:1;
  const closeDays=closed.filter(o=>o.closed_at).map(o=>(new Date(o.closed_at)-new Date(o.created_at))/86400000),avgClose=closeDays.length?closeDays.reduce((a,b)=>a+b,0)/closeDays.length:7;
  const repeated=obs.filter(o=>Number(o.repetition_count)>1).length,critical=obs.filter(o=>["high","critical"].includes(o.severity)).length;
  const warnings=Number((await one("select count(*)::int n from branch_warnings where branch_id=$1",[branchId]))?.n||0);
  const criticalItems=Number((await one(`select count(*)::int n from visit_items vi join visits v on v.id=vi.visit_id join operational_items oi on oi.id=vi.item_id where v.branch_id=$1 and oi.safety_critical=true and vi.score<60`,[branchId]))?.n||0);
  const components={performance:latest*.35,trend:Math.max(0,Math.min(15,7.5+trend*.75)),repetition:Math.max(0,10-repeated*2),executionSpeed:Math.max(0,10-Math.max(0,avgClose-3)*.8),warnings:Math.max(0,5-warnings),visitConfidence:Math.min(5,visits.length*.75),executionQuality:completion*10,criticalItems:Math.max(0,5-criticalItems*2),stability:Math.max(0,5-Math.sqrt(variance)*.65)};
  const score=Math.round(Math.max(0,Math.min(100,Object.values(components).reduce((a,b)=>a+b,0))));
  return {score,classification:score>=90?"excellent":score>=80?"good":score>=70?"average":score>=60?"weak":"critical",components,metrics:{latest,trend,repeated,critical,warnings,visits:visits.length,completion:Math.round(completion*100),averageCloseDays:Math.round(avgClose*10)/10,criticalItems,stability:Math.round(Math.max(0,100-Math.sqrt(variance)*10))}};
}
export async function periods(branchId){
  const result={};
  for(const [key,interval] of [["month","1 month"],["threeMonths","3 months"],["sixMonths","6 months"],["year","1 year"]]){
    result[key]=await one(`select count(*)::int visits,round(avg(final_score),1) average,max(final_score) highest,min(final_score) lowest from visits where branch_id=$1 and workflow_state='approved' and visit_date>=current_date-interval '${interval}'`,[branchId]);
  }
  return result;
}
