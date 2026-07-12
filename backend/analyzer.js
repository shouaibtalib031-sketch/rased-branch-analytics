import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { config } from "./config.js";

const finding={type:"object",additionalProperties:false,properties:{category:{type:"string"},description:{type:"string"},severity:{type:"string",enum:["low","medium","high","critical"]},confidence:{type:"number"}},required:["category","description","severity","confidence"]};
const warning={type:"object",additionalProperties:false,properties:{reason:{type:"string"},itemName:{type:"string"},questionNumber:{type:"string"},warningText:{type:"string"}},required:["reason","itemName","questionNumber","warningText"]};
const schema={type:"object",additionalProperties:false,properties:{branchName:{type:"string"},city:{type:"string"},region:{type:"string"},visitDate:{type:"string"},inspectorName:{type:"string"},reportNumber:{type:"string"},finalScore:{type:"number"},items:{type:"array",items:{type:"object",additionalProperties:false,properties:{name:{type:"string"},score:{type:"number"},notes:{type:"string"}},required:["name","score","notes"]}},observations:{type:"array",items:{type:"object",additionalProperties:false,properties:{body:{type:"string"},category:{type:"string"},severity:{type:"string",enum:["low","medium","high","critical"]},recommendation:{type:"string"}},required:["body","category","severity","recommendation"]}},warnings:{type:"array",items:warning},imageFindings:{type:"array",items:finding},summary:{type:"string"},managementRecommendation:{type:"string"},branchRecommendation:{type:"string"},urgent:{type:"boolean"}},required:["branchName","city","region","visitDate","inspectorName","reportNumber","finalScore","items","observations","warnings","imageFindings","summary","managementRecommendation","branchRecommendation","urgent"]};

async function extractText(file){
  const ext=path.extname(file.originalname).toLowerCase(),buf=await fs.readFile(file.path);
  if(ext===".pdf"){const p=new PDFParse({data:buf});const r=await p.getText();await p.destroy();return r.text}
  if(ext===".xlsx"){const wb=new ExcelJS.Workbook();await wb.xlsx.load(buf);const lines=[];wb.eachSheet(ws=>ws.eachRow(row=>lines.push(row.values.slice(1).map(v=>typeof v==="object"?JSON.stringify(v):String(v??"")).join(" | "))));return lines.join("\n")}
  if(ext===".docx")return (await mammoth.extractRawText({buffer:buf})).value;
  return "";
}
export async function analyzeFile(file){
  const ext=path.extname(file.originalname).toLowerCase(),isImage=[".png",".jpg",".jpeg",".webp"].includes(ext);
  const reportText=isImage?"":await extractText(file);
  if(!config.openaiKey)return deterministicExtraction(file.originalname,reportText);
  const client=new OpenAI({apiKey:config.openaiKey});
  const content=[{type:"input_text",text:`استخرج تقرير زيارة الفرع التالي بدقة. استخرج اسم "المراقب" الذي نفذ الزيارة فقط، وتجاهل أي اسم يظهر بصفة "المشرف". استخرج كل عبارة إنذار كما وردت حرفيًا، مع سببها وبندها ورقم السؤال إن وجد. الإنذارات سجل تاريخي وليست ملاحظات متابعة. استخرج جميع الملاحظات التشغيلية ولا تتركها فارغة إذا كانت موجودة في النص. لا تخمن الحقول غير الموجودة، واستخدم نصًا فارغًا عند غياب رقم السؤال أو التقرير. النص:\n${isImage?"الصورة مرفقة":reportText}`}];
  if(isImage)content.push({type:"input_image",image_url:`data:${file.mimetype};base64,${(await fs.readFile(file.path)).toString("base64")}`});
  const response=await client.responses.create({model:config.openaiModel,input:[{role:"system",content:"أنت محلل تدقيق تشغيلي. ميّز بدقة بين المراقب والمشرف: المطلوب هو المراقب فقط. أخرج البيانات العربية المنظمة حسب المخطط وحافظ على نص الإنذار حرفيًا."},{role:"user",content}],text:{format:{type:"json_schema",name:"branch_visit",strict:true,schema}}});
  const parsed=JSON.parse(response.output_text),fallback=deterministicExtraction(file.originalname,reportText);
  if(!parsed.observations?.length)parsed.observations=fallback.observations;
  if(!parsed.warnings?.length)parsed.warnings=fallback.warnings;
  if(!parsed.items?.length)parsed.items=fallback.items;
  return parsed;
}
function clean(value=""){return String(value).replace(/\s+/g," ").trim()}
function categoryOf(text=""){
  const t=text.replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").toLowerCase();
  const map=[["نظافة","نظاف"],["سلامة","سلامه امن حريق خطر"],["تخزين","تخزين مستودع"],["منتج","منتج منتجات جوده تالف"],["تخمير","تخمير"],["معدات","معدات ادوات قلايه فرن"],["أفراد","موظف عامل فريق افراد"],["خدمة","خدمه ضيافه كاشير"],["هوية بصرية","هويه بصر"],["الخبيز","خبيز خبز"],["التجهيز","تجهيز"]];
  return map.find(([,words])=>words.split(" ").some(w=>t.includes(w)))?.[0]||"تشغيل عام";
}
function severityOf(text=""){
  const t=text.replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").toLowerCase();
  if(/خطر|حرج|سلامه|تالف|منتهي|حريق|اصابه/.test(t))return "critical";
  if(/عاجل|ضعيف|مخالف|متاخر|صيانة|صيانه/.test(t))return "high";
  if(/بسيط|طفيف/.test(t))return "low";
  return "medium";
}
function firstMatch(text,patterns,fallback=""){
  for(const p of patterns){const m=text.match(p);if(m?.[1])return clean(m[1])}
  return fallback;
}
function deterministicExtraction(name,text=""){
  const lines=text.split(/\r?\n/).map(clean).filter(Boolean),joined=lines.join("\n");
  const warningLines=lines.filter(x=>/انذار|إنذار|warning/i.test(x)).slice(0,30);
  const observationLines=lines.filter(x=>!/انذار|إنذار|warning/i.test(x)&&/(ملاحظة|ملاحظات|يجب|يرجى|غير|ضعيف|تالف|منتهي|صيانة|صيانه|نظافة|تخزين|سلامة|منتج|معدات|تخمير|خبز|خدمة)/i.test(x)&&x.length>12).slice(0,80);
  const percentMatches=[...joined.matchAll(/(?:التقييم|النسبة|الدرجة|score)?\s*[:：]?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/gi)].map(x=>Number(x[1].replace(",","."))).filter(x=>x<=100);
  const date=firstMatch(joined,[/(\d{4}-\d{2}-\d{2})/,/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i],new Date().toISOString().slice(0,10));
  const parsedDate=Number.isNaN(Date.parse(date))?date:new Date(date).toISOString().slice(0,10);
  const branchName=firstMatch(joined,[/(?:اسم\s*)?الفرع\s*[:：-]\s*([^\n]+)/,/فرع\s+([^\n|،]+)/],name.replace(/\.[^.]+$/,""));
  const inspectorName=firstMatch(joined,[/المراقب\s*[:：-]\s*([^\n]+)/,/اسم\s+المراقب\s*[:：-]\s*([^\n]+)/],"مراقب غير محدد");
  const city=firstMatch(joined,[/المدينة\s*[:：-]\s*([^\n]+)/,/مدينة\s*[:：-]\s*([^\n]+)/],"غير محددة");
  const region=firstMatch(joined,[/المنطقة\s*[:：-]\s*([^\n]+)/],"غير محددة");
  const reportNumber=firstMatch(joined,[/رقم\s+التقرير\s*[:：-]\s*([^\n]+)/,/Report\s*No\.?\s*[:：-]\s*([^\n]+)/i],"");
  const observations=observationLines.map(line=>({body:line,category:categoryOf(line),severity:severityOf(line),recommendation:"معالجة الملاحظة وتوثيق الإجراء التصحيحي"}));
  const warnings=warningLines.map(line=>({reason:line.replace(/^(?:ال)?انذار\s*/i,""),itemName:categoryOf(line),questionNumber:firstMatch(line,[/سؤال\s*رقم\s*[:：-]?\s*(\d+)/,/Q(?:uestion)?\s*[:：-]?\s*(\d+)/i],""),warningText:line}));
  const itemNames=["الهوية البصرية","النظافة العامة","الأفراد","المنتجات","المعدات والأدوات","الأمن والسلامة","التخزين","التخمير","التجهيز","الخبيز","المنتج النهائي","الخدمة والضيافة"];
  const finalScore=percentMatches[0]??0;
  const items=itemNames.map(item=>({name:item,score:percentMatches.find((_,i)=>i>0)??finalScore,notes:observationLines.find(x=>categoryOf(x)===categoryOf(item))||""})).filter((_,i)=>i<Math.max(2,Math.min(12,percentMatches.length||itemNames.length)));
  return {branchName,city,region,visitDate:parsedDate,inspectorName,reportNumber,finalScore,items,observations,warnings,imageFindings:[],summary:`تم استخراج بيانات التقرير ${name} بقواعد تحليل نصية احتياطية.`,managementRecommendation:observations.some(o=>["high","critical"].includes(o.severity))||warnings.length?"مراجعة الملاحظات والإنذارات وتحديد خطة متابعة حسب الأولوية.":"اعتماد المتابعة الدورية مع تثبيت نقاط القوة.",branchRecommendation:"إغلاق الملاحظات بالصور وتوثيق الإجراءات التصحيحية.",urgent:finalScore<60||observations.some(o=>o.severity==="critical")};
}
