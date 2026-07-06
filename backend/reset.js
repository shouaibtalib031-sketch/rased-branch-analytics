import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { transaction } from "./db.js";
import { clearCache } from "./enterprise.js";

async function existingFiles(directory){
  try{return (await fs.readdir(directory,{withFileTypes:true})).filter(x=>x.isFile()&&x.name!==".gitkeep").map(x=>path.join(directory,x.name))}
  catch(error){if(error.code==="ENOENT")return [];throw error}
}

export async function resetOperationalData({simulateFailure=false}={}){
  const files=[...await existingFiles(config.uploadDir),...await existingFiles(config.outputPdfDir)];
  const quarantine=path.resolve("./storage",`.reset-${randomUUID()}`),moved=[];
  await fs.mkdir(quarantine,{recursive:true});
  let counts;
  try{
    for(const source of files){
      const target=path.join(quarantine,`${moved.length}-${path.basename(source)}`);
      await fs.rename(source,target);moved.push({source,target});
    }
    counts=await transaction(async client=>{
      const count=async table=>Number((await client.query(`select count(*)::int n from ${table}`)).rows[0]?.n||0);
      const before={branches:await count("branches"),reports:await count("reports"),visits:await count("visits"),observations:await count("observations"),warnings:await count("branch_warnings"),supervisors:await count("supervisors")};
      for(const table of ["observation_workflow","timeline_events","observation_images","recommendations","ai_analysis","branch_warnings","observations","visit_items","visits","reports","notifications","ai_conversations","scheduled_reports","audit_logs","login_logs"])await client.query(`delete from ${table}`);
      if(simulateFailure)throw new Error("SIMULATED_RESET_FAILURE");
      await client.query("delete from supervisors");
      await client.query("delete from branches");
      await client.query(`insert into system_state(key,value,updated_at) values('production_initialized',$1,now()) on conflict(key) do update set value=excluded.value,updated_at=now()`,[JSON.stringify(true)]);
      return before;
    });
  }catch(error){
    for(const entry of moved.reverse())await fs.rename(entry.target,entry.source).catch(()=>{});
    await fs.rm(quarantine,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
  await fs.rm(quarantine,{recursive:true,force:true}).catch(()=>{});
  clearCache();
  return {...counts,filesDeleted:moved.length};
}
