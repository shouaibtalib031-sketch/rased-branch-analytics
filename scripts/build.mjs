import fs from "node:fs/promises";
import path from "node:path";

const root=path.resolve(import.meta.dirname,"..");
const dist=path.join(root,"dist");
await fs.rm(dist,{recursive:true,force:true});
await fs.mkdir(dist,{recursive:true});
for(const file of ["index.html","app.js","styles.css"]){
  await fs.copyFile(path.join(root,file),path.join(dist,file));
}
console.log("Production frontend built in dist/");
