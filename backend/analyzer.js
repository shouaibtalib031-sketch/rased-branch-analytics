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
  if(!config.openaiKey)return demoExtraction(file.originalname);
  const client=new OpenAI({apiKey:config.openaiKey});
  const content=[{type:"input_text",text:`استخرج تقرير زيارة الفرع التالي بدقة. استخرج اسم "المراقب" الذي نفذ الزيارة فقط، وتجاهل أي اسم يظهر بصفة "المشرف". استخرج كل عبارة إنذار كما وردت حرفيًا، مع سببها وبندها ورقم السؤال إن وجد. الإنذارات سجل تاريخي وليست ملاحظات متابعة. لا تخمن الحقول غير الموجودة، واستخدم نصًا فارغًا عند غياب رقم السؤال أو التقرير. النص:\n${isImage?"الصورة مرفقة":await extractText(file)}`}];
  if(isImage)content.push({type:"input_image",image_url:`data:${file.mimetype};base64,${(await fs.readFile(file.path)).toString("base64")}`});
  const response=await client.responses.create({model:config.openaiModel,input:[{role:"system",content:"أنت محلل تدقيق تشغيلي. ميّز بدقة بين المراقب والمشرف: المطلوب هو المراقب فقط. أخرج البيانات العربية المنظمة حسب المخطط وحافظ على نص الإنذار حرفيًا."},{role:"user",content}],text:{format:{type:"json_schema",name:"branch_visit",strict:true,schema}}});
  return JSON.parse(response.output_text);
}
function demoExtraction(name){return {branchName:"فرع النزهة",city:"الباحة",region:"الجنوبية",visitDate:"2026-06-13",inspectorName:"أحمد حامد",reportNumber:"RPT-2026-0613",finalScore:88.51,items:[{name:"المنتجات",score:82,notes:"مراجعة المنتجات المرسلة من المعمل"},{name:"النظافة العامة",score:91,notes:"جيد"}],observations:[],warnings:[{reason:"المنتجات المرسلة من معمل الشركة",itemName:"المنتجات",questionNumber:"",warningText:"الانذار الاول خاص بالمنتجات المرسلة من معمل الشركة"}],imageFindings:[],summary:`تحليل تجريبي آمن للملف ${name} لعدم إعداد OPENAI_API_KEY.`,managementRecommendation:"مراجعة جودة المنتجات الواردة من المعمل",branchRecommendation:"توثيق المنتجات المستلمة والتحقق منها",urgent:false}}
