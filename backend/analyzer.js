import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { PDFParse } from "pdf-parse";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { config } from "./config.js";

const finding={type:"object",additionalProperties:false,properties:{category:{type:"string"},description:{type:"string"},severity:{type:"string",enum:["low","medium","high","critical"]},confidence:{type:"number"}},required:["category","description","severity","confidence"]};
const warning={type:"object",additionalProperties:false,properties:{reason:{type:"string"},itemName:{type:"string"},questionNumber:{type:"string"},warningText:{type:"string"}},required:["reason","itemName","questionNumber","warningText"]};
const schema={type:"object",additionalProperties:false,properties:{branchName:{type:"string"},city:{type:"string"},region:{type:"string"},visitDate:{type:"string"},inspectorName:{type:"string"},reportNumber:{type:"string"},finalScore:{type:"number"},items:{type:"array",items:{type:"object",additionalProperties:false,properties:{name:{type:"string"},score:{type:"number"},notes:{type:"string"}},required:["name","score","notes"]}},observations:{type:"array",items:{type:"object",additionalProperties:false,properties:{body:{type:"string"},category:{type:"string"},severity:{type:"string",enum:["low","medium","high","critical"]},recommendation:{type:"string"}},required:["body","category","severity","recommendation"]}},warnings:{type:"array",items:warning},imageFindings:{type:"array",items:finding},summary:{type:"string"},managementRecommendation:{type:"string"},branchRecommendation:{type:"string"},urgent:{type:"boolean"}},required:["branchName","city","region","visitDate","inspectorName","reportNumber","finalScore","items","observations","warnings","imageFindings","summary","managementRecommendation","branchRecommendation","urgent"]};

async function extractText(file){
  console.log("TEXT_EXTRACTION_STARTED",JSON.stringify({filename:file.originalname}));
  const ext=path.extname(file.originalname).toLowerCase(),buf=await fs.readFile(file.path);
  let text="";
  if(ext===".pdf"){
    const positional=await extractPdfLayout(buf,file.originalname);
    const p=new PDFParse({data:buf});const r=await p.getText();await p.destroy();
    text=[positional.text,r.text].filter(Boolean).join("\n");
    logPageDebug(file.originalname,text);
    console.log("EXTRACTION_DEBUG_FIRST_PAGE_RAW",JSON.stringify({filename:file.originalname,text:positional.firstPageRaw.slice(0,4000),fields:positional.fields}));
  }
  else if(ext===".xlsx"){const wb=new ExcelJS.Workbook();await wb.xlsx.load(buf);const lines=[];wb.eachSheet(ws=>ws.eachRow(row=>lines.push(row.values.slice(1).map(v=>typeof v==="object"?JSON.stringify(v):String(v??"")).join(" | "))));text=lines.join("\n")}
  else if(ext===".docx")text=(await mammoth.extractRawText({buffer:buf})).value;
  console.log("TEXT_EXTRACTION_COMPLETED",JSON.stringify({filename:file.originalname,characters:text.length}));
  return text;
}
export async function analyzeFile(file){
  const ext=path.extname(file.originalname).toLowerCase(),isImage=[".png",".jpg",".jpeg",".webp"].includes(ext);
  const reportText=isImage?"":await extractText(file);
  if(!config.openaiKey){console.log("ANALYSIS_STARTED",JSON.stringify({filename:file.originalname,mode:"deterministic"}));const output=deterministicExtraction(file.originalname,reportText);console.log("ANALYSIS_COMPLETED",JSON.stringify({filename:file.originalname,mode:"deterministic",observations:output.observations.length,warnings:output.warnings.length}));return output}
  const client=new OpenAI({apiKey:config.openaiKey});
  const content=[{type:"input_text",text:`استخرج تقرير زيارة الفرع التالي بدقة. استخرج اسم "المراقب" الذي نفذ الزيارة فقط، وتجاهل أي اسم يظهر بصفة "المشرف". استخرج كل عبارة إنذار كما وردت حرفيًا، مع سببها وبندها ورقم السؤال إن وجد. الإنذارات سجل تاريخي وليست ملاحظات متابعة. استخرج جميع الملاحظات التشغيلية ولا تتركها فارغة إذا كانت موجودة في النص. لا تخمن الحقول غير الموجودة، واستخدم نصًا فارغًا عند غياب رقم السؤال أو التقرير. النص:\n${isImage?"الصورة مرفقة":reportText}`}];
  if(isImage)content.push({type:"input_image",image_url:`data:${file.mimetype};base64,${(await fs.readFile(file.path)).toString("base64")}`});
  console.log("ANALYSIS_STARTED",JSON.stringify({filename:file.originalname,mode:"openai",model:config.openaiModel}));
  const response=await client.responses.create({model:config.openaiModel,input:[{role:"system",content:"أنت محلل تدقيق تشغيلي. ميّز بدقة بين المراقب والمشرف: المطلوب هو المراقب فقط. أخرج البيانات العربية المنظمة حسب المخطط وحافظ على نص الإنذار حرفيًا."},{role:"user",content}],text:{format:{type:"json_schema",name:"branch_visit",strict:true,schema}}});
  const parsed=JSON.parse(response.output_text),fallback=deterministicExtraction(file.originalname,reportText);
  for(const key of ["branchName","city","region","visitDate","inspectorName","reportNumber"])if(!clean(parsed[key]))parsed[key]=fallback[key];
  if(parsed.finalScore===null||parsed.finalScore===undefined||Number.isNaN(Number(parsed.finalScore)))parsed.finalScore=fallback.finalScore;
  if(!parsed.observations?.length)parsed.observations=fallback.observations;
  if(!parsed.warnings?.length)parsed.warnings=fallback.warnings;
  if(!parsed.items?.length)parsed.items=fallback.items;
  console.log("ANALYSIS_COMPLETED",JSON.stringify({filename:file.originalname,mode:"openai",observations:parsed.observations.length,warnings:parsed.warnings.length}));
  return parsed;
}
function clean(value=""){return String(value).replace(/\s+/g," ").trim()}
function compact(value=""){return clean(String(value).replace(/[\u200e\u200f\u202a-\u202e]/g,"").replace(/[|•·]+/g," ").replace(/[‐‑‒–—―]/g,"-"))}
function westernDigits(value=""){
  const arabic="٠١٢٣٤٥٦٧٨٩",persian="۰۱۲۳۴۵۶۷۸۹";
  return String(value).replace(/[٠-٩۰-۹]/g,ch=>{
    const a=arabic.indexOf(ch);
    return String(a>=0?a:persian.indexOf(ch));
  }).replace(/٫/g,".").replace(/٬/g,",");
}
function normalized(value=""){return westernDigits(compact(value)).replace(/[أإآ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")}
function splitPages(text=""){
  const chunks=String(text).split(/\n\s*--\s*\d+\s+of\s+\d+\s*--\s*\n/g).map(x=>x.trim()).filter(Boolean);
  return chunks.length?chunks:[String(text||"")];
}
function lineList(text=""){return String(text||"").split(/\r?\n/).map(compact).filter(Boolean)}
async function extractPdfLayout(buffer,filename){
  const doc=await getDocument({data:new Uint8Array(buffer),useWorkerFetch:false,isEvalSupported:false,disableFontFace:true}).promise;
  const pages=[];
  let fields={};
  try{
    for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
      const page=await doc.getPage(pageNo),content=await page.getTextContent({includeMarkedContent:true});
      const items=content.items.filter(x=>compact(x.str)).map(x=>({text:compact(x.str),x:Number(x.transform?.[4]||0),y:Number(x.transform?.[5]||0),w:Number(x.width||0),h:Number(x.height||0)}));
      const rows=layoutRows(items),raw=rows.map(row=>row.items.map(i=>i.text).join(" ")).join("\n");
      if(pageNo===1)fields=extractNearbyPdfFields(rows);
      pages.push(`[[PDF_PAGE_${pageNo}_LAYOUT]]\n${raw}`);
      console.log("EXTRACTION_DEBUG_PDF_LAYOUT_PAGE",JSON.stringify({filename,page:pageNo,items:items.length,rows:rows.length,sample:rows.slice(0,18).map(r=>r.items.map(i=>i.text).join(" "))}));
    }
  }finally{await doc.destroy()}
  const fieldLines=[
    fields.branchName&&`اسم الفرع: ${fields.branchName}`,
    fields.city&&`المدينة: ${fields.city}`,
    fields.region&&`المنطقة: ${fields.region}`,
    fields.inspectorName&&`اسم المراقب: ${fields.inspectorName}`,
    fields.visitDate&&`تاريخ الزيارة: ${fields.visitDate}`,
    fields.reportNumber&&`رقم التقرير: ${fields.reportNumber}`,
    fields.finalScore!==null&&fields.finalScore!==undefined&&`التقييم النهائي: ${fields.finalScore}%`
  ].filter(Boolean).join("\n");
  return {text:[fieldLines,pages.join("\n\n")].filter(Boolean).join("\n"),firstPageRaw:pages[0]||"",fields};
}
function layoutRows(items){
  const sorted=[...items].sort((a,b)=>Math.abs(b.y-a.y)>3?b.y-a.y:a.x-b.x),rows=[];
  for(const item of sorted){
    let row=rows.find(r=>Math.abs(r.y-item.y)<=3);
    if(!row){row={y:item.y,items:[]};rows.push(row)}
    row.items.push(item);
    row.y=(row.y*(row.items.length-1)+item.y)/row.items.length;
  }
  return rows.sort((a,b)=>b.y-a.y).map(row=>({...row,items:row.items.sort((a,b)=>a.x-b.x)}));
}
function extractNearbyPdfFields(rows){
  const pick=(labels,options={})=>{
    const normalizedLabels=labels.map(normalized);
    for(let ri=0;ri<rows.length;ri++){
      const row=rows[ri],items=row.items,rowText=normalized(items.map(i=>i.text).join(" "));
      const labelIndex=items.findIndex(i=>normalizedLabels.some(l=>normalized(i.text).includes(l)));
      if(labelIndex<0&&!normalizedLabels.some(l=>rowText.includes(l)))continue;
      const candidates=[];
      if(labelIndex>=0){
        for(let j=labelIndex+1;j<items.length;j++)candidates.push(items[j].text);
        for(let j=labelIndex-1;j>=0;j--)candidates.push(items[j].text);
      }
      const stripped=stripLabels(items.map(i=>i.text).join(" "),labels);
      if(stripped)candidates.unshift(stripped);
      for(let nr=ri+1;nr<Math.min(rows.length,ri+4);nr++)candidates.push(rows[nr].items.map(i=>i.text).join(" "));
      const value=candidates.map(x=>cleanCandidateValue(x,labels,options)).find(x=>isUsefulFieldValue(x,options));
      if(value)return value;
    }
    return "";
  };
  const branchName=pick(["اسم الفرع","الفرع","Branch Name","Branch","Store Name","Location"],{reject:["المراقب","المشرف","تاريخ","التقييم","score","date"]});
  const city=pick(["المدينة","مدينه","City"],{reject:["الفرع","المراقب","تاريخ"]});
  const region=pick(["المنطقة","المنطقه","Region","Area"],{reject:["الفرع","المراقب","تاريخ"]});
  const inspectorName=pick(["اسم المراقب","المراقب","منفذ الزيارة","منفذ الزياره","المدقق","Inspector","Auditor","Monitor","Visited By"],{reject:["المشرف","supervisor","تاريخ","الفرع","score"]});
  const visitDate=parseVisitDate(pick(["تاريخ الزيارة","تاريخ الزياره","تاريخ التقرير","Visit Date","Inspection Date","Report Date","Date"],{date:true}))||"";
  const reportNumber=pick(["رقم التقرير","رقم الزيارة","رقم الزياره","Report No","Report Number"],{reject:["تاريخ","الفرع"]});
  const finalScore=extractFinalScore(rows.map(r=>r.items.map(i=>i.text).join(" ")));
  return {...splitBranchCity(branchName,city),region,inspectorName,visitDate,reportNumber,finalScore};
}
function stripLabels(value,labels){
  let out=compact(value);
  for(const label of labels)out=out.replace(new RegExp(escapeRegex(label),"ig")," ");
  return trimFieldValue(out);
}
function cleanCandidateValue(value,labels,options={}){
  let out=stripLabels(value,labels).replace(/^[\\s:：|\\/\\\\._-]+|[\\s:：|\\/\\\\._-]+$/g,"");
  if(options.date){
    const date=normalized(out).match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i)?.[0]||normalized(out).match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/)?.[0]||normalized(out).match(/\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/)?.[0]||out;
    return date;
  }
  return trimFieldValue(out,options.reject||[]);
}
function isUsefulFieldValue(value,options={}){
  const v=compact(value),n=normalized(v);
  if(!v||v.length<2)return false;
  if(options.date)return Boolean(parseVisitDate(v));
  if(/^(اسم|الفرع|المراقب|المدقق|المدينة|المنطقة|تاريخ|branch|inspector|auditor|city|region|date)$/i.test(n))return false;
  if((options.reject||[]).some(x=>n.includes(normalized(x))))return false;
  if(/GOA[-_ ]|\\.pdf|\\.docx|\\.xlsx/i.test(v))return false;
  return true;
}
function logPageDebug(filename,text){
  splitPages(text).forEach((page,index)=>{
    const lines=lineList(page),pageText=lines.join("\n"),n=normalized(pageText);
    const candidates={
      branch:/الفرع|branch|store|location/i.test(n),
      inspector:/المراقب|المدقق|inspector|auditor|monitor/i.test(n),
      supervisor:/المشرف|supervisor/i.test(n),
      date:/تاريخ|date|visit/i.test(n),
      score:/%|التقييم|النسبه|score/i.test(n),
      warning:/انذار|warning/i.test(n),
      observations:/ملاحظه|ملاحظات|observation|يجب|غير|صيانة|صيانه/i.test(n)
    };
    console.log("EXTRACTION_DEBUG_PAGE",JSON.stringify({filename,page:index+1,characters:page.length,lines:lines.length,candidates,sample:lines.slice(0,18)}));
  });
}
function trimFieldValue(value="",stops=[]){
  let out=compact(value).replace(/^[؛:：\\/\-|]+/,"").trim();
  const stopWords=["اسم الفرع","الفرع","المدينة","مدينه","المنطقة","المنطقه","المراقب","اسم المراقب","المشرف","تاريخ الزيارة","تاريخ الزياره","تاريخ التقرير","رقم التقرير","التقييم","النسبة","النسبه","branch","city","region","inspector","auditor","supervisor","visit date","report no","score",...stops];
  const stopRegex=new RegExp(`\\s+(?:${stopWords.map(escapeRegex).join("|")})\\s*[:：-]?`,"i");
  out=out.split(stopRegex)[0]||out;
  return clean(out.replace(/^(فرع)\s*[:：-]\s*/,"$1 "));
}
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}
function valuesAfterLabel(lines,labels,{exclude=[]}={}){
  const out=[];
  for(let i=0;i<lines.length;i++){
    const raw=lines[i],n=normalized(raw);
    if(exclude.some(x=>n.includes(normalized(x))))continue;
    for(const label of labels){
      const l=normalized(label);
      if(!n.includes(l))continue;
      const same=raw.slice(Math.max(0,n.indexOf(l)+label.length));
      const sameValue=trimFieldValue(same);
      if(sameValue&&sameValue.length>=2&&!sameValue.match(/^[:：\-\s]*$/))out.push(sameValue);
      for(let j=i+1;j<Math.min(lines.length,i+4);j++){
        const next=trimFieldValue(lines[j]);
        const nn=normalized(next);
        if(!next||labels.some(x=>nn===normalized(x))||exclude.some(x=>nn.includes(normalized(x))))continue;
        if(next.length>=2)out.push(next);
        break;
      }
    }
  }
  return [...new Set(out.map(x=>trimFieldValue(x)).filter(Boolean))];
}
function firstField(lines,patterns,labels=[],options={}){
  const joined=lines.join("\n"),norm=normalized(joined);
  for(const p of patterns){
    const m=norm.match(p);
    if(m?.[1])return trimFieldValue(m[1],options.stops);
  }
  return valuesAfterLabel(lines,labels,options).find(Boolean)||"";
}
function parseVisitDate(value=""){
  const months={يناير:"Jan",فبراير:"Feb",مارس:"Mar",ابريل:"Apr",ابريل:"Apr",مايو:"May",يونيو:"Jun",يونيه:"Jun",جوان:"Jun",يوليو:"Jul",اغسطس:"Aug",سبتمبر:"Sep",اكتوبر:"Oct",نوفمبر:"Nov",ديسمبر:"Dec"};
  const monthNumbers={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",june:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  let v=westernDigits(compact(value)).replace(/(\d)(st|nd|rd|th)/gi,"$1");
  for(const [ar,en] of Object.entries(months))v=v.replace(new RegExp(ar,"gi"),en);
  const slash=v.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if(slash){
    const d=slash[1].padStart(2,"0"),m=slash[2].padStart(2,"0"),y=slash[3].length===2?`20${slash[3]}`:slash[3];
    return `${y}-${m}-${d}`;
  }
  const iso=v.match(/\b(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
  if(iso)return `${iso[1]}-${iso[2].padStart(2,"0")}-${iso[3].padStart(2,"0")}`;
  const natural=v.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/i);
  if(natural){
    const month=monthNumbers[natural[2].toLowerCase().slice(0,3)]||monthNumbers[natural[2].toLowerCase()];
    if(month)return `${natural[3]}-${month}-${natural[1].padStart(2,"0")}`;
  }
  return "";
}
function extractDate(lines){
  const joined=normalized(lines.join("\n"));
  const candidates=[
    ...valuesAfterLabel(lines,["تاريخ الزيارة","تاريخ الزياره","تاريخ التقرير","Visit Date","Date of Visit","Inspection Date","Report Date"]),
    firstMatch(joined,[/تاريخ\s*(?:الزياره|التقرير)?\s*[:：-]?\s*([^\n]+)/,/visit\s*date\s*[:：-]?\s*([^\n]+)/i,/date\s*[:：-]?\s*([^\n]+)/i,/بتاريخ\s*([^\n]+)/])
  ].filter(Boolean);
  const free=joined.match(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i)?.[0]||joined.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/)?.[0]||joined.match(/\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/)?.[0]||"";
  candidates.push(free);
  return candidates.map(parseVisitDate).find(Boolean)||"";
}
function splitBranchCity(branchName="",city=""){
  let branch=trimFieldValue(branchName),detectedCity=trimFieldValue(city);
  const hyphen=branch.match(/^(.+?)\s+-\s+(.+)$/);
  if(hyphen){branch=clean(hyphen[1]);detectedCity=detectedCity||clean(hyphen[2])}
  return {branch,city:detectedCity};
}
function extractBranchCityRegion(lines){
  const joined=normalized(lines.join("\n"));
  let branch=firstField(lines,[/(?:اسم\s*)?الفرع\s*[:：-]\s*([^\n]+)/,/branch\s*(?:name)?\s*[:：-]\s*([^\n]+)/i,/store\s*(?:name)?\s*[:：-]\s*([^\n]+)/i,/location\s*[:：-]\s*([^\n]+)/i,/فرع\s+([^\n]{2,80}?)(?:\s+بتاريخ|\n|$)/],["اسم الفرع","الفرع","Branch Name","Branch","Store Name","Store","Location"]);
  const city=firstField(lines,[/المدين(?:ه|ة)\s*[:：-]\s*([^\n]+)/,/city\s*[:：-]\s*([^\n]+)/i],["المدينة","مدينه","City"]);
  const region=firstField(lines,[/المنطق(?:ه|ة)\s*[:：-]\s*([^\n]+)/,/region\s*[:：-]\s*([^\n]+)/i,/area\s*[:：-]\s*([^\n]+)/i],["المنطقة","المنطقه","Region","Area"]);
  if(!branch){
    const khalid=lines.find(x=>/Khalid\s+Cell/i.test(x)&&x.split("-").length>=3);
    if(khalid){
      const parts=khalid.split("-").map(clean).filter(Boolean);
      branch=parts.at(-2)||parts.at(0)||"";
      return {branchName:branch,city:city||parts.at(-1)||"",region};
    }
  }
  const split=splitBranchCity(branch,city);
  return {branchName:split.branch,city:split.city,region};
}
function extractInspector(lines){
  const labels=["اسم المراقب","المراقب","المدقق","مسؤول الزيارة","منفذ الزيارة","Auditor","Inspector","Monitor","Visited By","Prepared By"];
  return firstField(lines,[/اسم\s+المراقب\s*[:：-]\s*([^\n]+)/,/المراقب\s*[:：-]\s*([^\n]+)/,/المدقق\s*[:：-]\s*([^\n]+)/,/inspector\s*[:：-]\s*([^\n]+)/i,/auditor\s*[:：-]\s*([^\n]+)/i,/monitor\s*[:：-]\s*([^\n]+)/i,/visited\s+by\s*[:：-]\s*([^\n]+)/i,/prepared\s+by\s*[:：-]\s*([^\n]+)/i],labels,{exclude:["المشرف","supervisor"]});
}
function extractFinalScore(lines){
  const joined=normalized(lines.join("\n"));
  const specific=[
    /(?:التقييم|النسبه|الدرجه)\s*(?:النهائيه|العامه|الكليه|الاجماليه)?\s*[:：-]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i,
    /(?:final|overall|total)\s*(?:score|rating|percentage)?\s*[:：-]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i
  ];
  for(const p of specific){const m=joined.match(p);if(m)return Number(m[1].replace(",","."))}
  const all=[...joined.matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/g)].map(x=>Number(x[1].replace(",","."))).filter(x=>x>=0&&x<=100);
  return all[0]??null;
}
const operationalItems=[
  {name:"الهوية البصرية",aliases:["الهوية البصرية","الهويه البصريه","identity","visual"]},
  {name:"النظافة العامة",aliases:["النظافة العامة","النظافه العامه","النظافة","نظافه","cleanliness","hygiene"]},
  {name:"الأفراد",aliases:["الأفراد","الافراد","الموظفين","الفريق","staff","people"]},
  {name:"المنتجات",aliases:["المنتجات","منتجات","product","products"]},
  {name:"المعدات والأدوات",aliases:["المعدات والأدوات","المعدات","الادوات","equipment","tools"]},
  {name:"الأمن والسلامة",aliases:["الأمن والسلامة","الامن والسلامه","السلامة","سلامه","safety","security"]},
  {name:"التخزين",aliases:["التخزين","storage"]},
  {name:"التخمير",aliases:["التخمير","fermentation"]},
  {name:"التجهيز",aliases:["التجهيز","preparation"]},
  {name:"الخبيز",aliases:["الخبيز","الخبز","baking"]},
  {name:"المنتج النهائي",aliases:["المنتج النهائي","final product"]},
  {name:"الخدمة والضيافة",aliases:["الخدمة والضيافة","الخدمه والضيافه","الخدمة","الضيافة","service","hospitality"]},
  {name:"التزام الكاشير",aliases:["الكاشير","cashier"]},
  {name:"توافر منتجات المنيو",aliases:["توافر منتجات المنيو","توفر المنتجات","menu availability"]},
  {name:"رصد المخالفات",aliases:["رصد المخالفات","المخالفات","violations"]}
];
function percentIn(text=""){
  const m=westernDigits(text).match(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/);
  if(!m)return null;
  const n=Number(m[1].replace(",","."));
  return n>=0&&n<=100?n:null;
}
function extractItems(lines,finalScore){
  const items=[];
  const normalizedLines=lines.map(normalized);
  for(const item of operationalItems){
    let score=null,notes="";
    for(let i=0;i<lines.length;i++){
      if(!item.aliases.some(a=>normalizedLines[i].includes(normalized(a))))continue;
      const window=lines.slice(i,Math.min(lines.length,i+4)).join(" ");
      score=percentIn(window);
      const noteLine=lines.slice(i,Math.min(lines.length,i+5)).find(x=>/(ملاحظه|ملاحظات|يجب|غير|ضعيف|تالف|صيانة|صيانه|observation|note|required|maintenance)/i.test(normalized(x)));
      notes=noteLine||"";
      break;
    }
    if(score!==null)items.push({name:item.name,score,notes});
  }
  if(items.length)return items;
  const percentages=[...normalized(lines.join("\n")).matchAll(/(\d{1,3}(?:[.,]\d{1,2})?)\s*%/g)].map(x=>Number(x[1].replace(",","."))).filter(x=>x>=0&&x<=100);
  return operationalItems.slice(0,Math.max(2,Math.min(12,percentages.length||operationalItems.length))).map((item,i)=>({name:item.name,score:percentages[i+1]??percentages[i]??finalScore,notes:""})).filter(x=>x.score!==null&&x.score!==undefined&&!Number.isNaN(Number(x.score)));
}
function extractReportNumber(lines){
  return firstField(lines,[/رقم\s+(?:التقرير|الزيارة|الزياره)\s*[:：-]\s*([^\n]+)/,/report\s*(?:no|number|#)?\s*[:：-]\s*([^\n]+)/i,/RPT[-\w\d]+/i],["رقم التقرير","رقم الزيارة","Report No","Report Number"]);
}
function categoryOf(text=""){
  const t=text.replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").toLowerCase();
  const map=[["نظافة","نظاف clean cleanliness hygiene"],["سلامة","سلامه امن حريق خطر safety risk hazard fire"],["تخزين","تخزين مستودع storage warehouse"],["منتج","منتج منتجات جوده تالف product products quality damaged"],["تخمير","تخمير fermentation"],["معدات","معدات ادوات قلايه فرن equipment fryer oven maintenance"],["أفراد","موظف عامل فريق افراد staff employee team"],["خدمة","خدمه ضيافه كاشير service cashier hospitality"],["هوية بصرية","هويه بصر identity branding"],["الخبيز","خبيز خبز baking bakery"],["التجهيز","تجهيز preparation"]];
  return map.find(([,words])=>words.split(" ").some(w=>t.includes(w)))?.[0]||"تشغيل عام";
}
function severityOf(text=""){
  const t=text.replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").toLowerCase();
  if(/خطر|حرج|سلامه|تالف|منتهي|حريق|اصابه|critical|hazard|expired|damaged/.test(t))return "critical";
  if(/عاجل|ضعيف|مخالف|متاخر|صيانة|صيانه|high|maintenance|required|must/.test(t))return "high";
  if(/بسيط|طفيف/.test(t))return "low";
  return "medium";
}
function firstMatch(text,patterns,fallback=""){
  for(const p of patterns){const m=text.match(p);if(m?.[1])return clean(m[1])}
  return fallback;
}
function deterministicExtraction(name,text=""){
  const lines=lineList(text),joined=lines.join("\n");
  const warningLines=lines.filter(x=>/انذار|إنذار|warning/i.test(x)).slice(0,30);
  const observationLines=lines.filter(x=>!/انذار|إنذار|warning/i.test(x)&&/(ملاحظة|ملاحظات|يجب|يرجى|غير|ضعيف|تالف|منتهي|صيانة|صيانه|نظافة|تخزين|سلامة|منتج|معدات|تخمير|خبز|خدمة|observation|must|required|maintenance|clean|storage|safety|product|equipment|service|quality)/i.test(x)&&x.length>12).slice(0,80);
  const branchData=extractBranchCityRegion(lines);
  const parsedDate=extractDate(lines);
  const inspectorName=extractInspector(lines);
  const reportNumber=extractReportNumber(lines);
  const finalScore=extractFinalScore(lines);
  const observations=observationLines.map(line=>({body:line,category:categoryOf(line),severity:severityOf(line),recommendation:"معالجة الملاحظة وتوثيق الإجراء التصحيحي"}));
  const warnings=warningLines.map(line=>({reason:line.replace(/^(?:ال)?انذار\s*/i,""),itemName:categoryOf(line),questionNumber:firstMatch(line,[/سؤال\s*رقم\s*[:：-]?\s*(\d+)/,/Q(?:uestion)?\s*[:：-]?\s*(\d+)/i],""),warningText:line}));
  const items=extractItems(lines,finalScore).map(item=>({...item,notes:item.notes||observationLines.find(x=>categoryOf(x)===categoryOf(item.name))||""}));
  const output={branchName:branchData.branchName,city:branchData.city,region:branchData.region,visitDate:parsedDate,inspectorName,reportNumber,finalScore,items,observations,warnings,imageFindings:[],summary:`تم استخراج بيانات التقرير ${name} من محتوى الملف فقط.`,managementRecommendation:observations.some(o=>["high","critical"].includes(o.severity))||warnings.length?"مراجعة الملاحظات والإنذارات وتحديد خطة متابعة حسب الأولوية.":"اعتماد المتابعة الدورية مع تثبيت نقاط القوة.",branchRecommendation:"إغلاق الملاحظات بالصور وتوثيق الإجراءات التصحيحية.",urgent:Number(finalScore)<60||observations.some(o=>o.severity==="critical")};
  console.log("EXTRACTION_FIELD_DEBUG",JSON.stringify({filename:name,found:{branchName:!!output.branchName,city:!!output.city,region:!!output.region,visitDate:!!output.visitDate,inspectorName:!!output.inspectorName,reportNumber:!!output.reportNumber,finalScore:output.finalScore!==null,items:output.items.length,observations:output.observations.length,warnings:output.warnings.length},values:{branchName:output.branchName,city:output.city,region:output.region,visitDate:output.visitDate,inspectorName:output.inspectorName,reportNumber:output.reportNumber,finalScore:output.finalScore},missingReasons:Object.fromEntries(Object.entries({branchName:"لم يظهر حقل الفرع بأي من الصيغ المعروفة أو كان النص العربي غير قابل للاستخراج من PDF",inspectorName:"لم يظهر حقل المراقب/المدقق، وتم تجاهل أي حقل مشرف حسب القاعدة",visitDate:"لم يظهر تاريخ قابل للتحويل مثل 2026-06-13 أو 13 June 2026 أو 13/06/2026",finalScore:"لم تظهر نسبة تقييم نهائية أو أي نسبة مئوية صالحة",items:"لم تظهر أسماء البنود التشغيلية مع نسب قابلة للقراءة"}).filter(([k])=>k==="items"?!output.items.length:!output[k]))}));
  return output;
}
