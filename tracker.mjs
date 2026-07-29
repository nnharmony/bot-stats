import fs from "node:fs/promises";
const bots=JSON.parse(await fs.readFile("bots.json","utf8"));
const path="data/history.json";
async function getStats(bot){
 const r=await fetch(bot.url,{headers:{"user-agent":"Mozilla/5.0","accept-language":"en-US,en;q=0.9"},redirect:"follow"});
 if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
 const html=await r.text();
 for(const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const p=JSON.parse(m[1]); for(const c of (Array.isArray(p)?p:[p])){const s=c?.interactionStatistic;if(!Array.isArray(s))continue;const x=Object.fromEntries(s.map(i=>[String(i.interactionType||"").split("/").pop(),Number(i.userInteractionCount)]));if(Number.isFinite(x.WriteAction))return{name:c.name||bot.name,url:bot.url,messages:x.WriteAction,collectors:Number.isFinite(x.FollowAction)?x.FollowAction:null};}}catch{}
 }
 throw new Error("No interaction statistics found");
}
let h;try{h=JSON.parse(await fs.readFile(path,"utf8"));}catch{h={generated_at:null,snapshots:[]};}
const out=[];
for(const bot of bots){try{const s=await getStats(bot);out.push(s);console.log(`✓ ${s.name}: ${s.messages}`);}catch(e){out.push({name:bot.name,url:bot.url,messages:null,collectors:null,error:String(e.message||e)});console.error(`✗ ${bot.name}: ${e.message||e}`);}await new Promise(r=>setTimeout(r,1500));}
const snap={timestamp:new Date().toISOString(),bots:out};h.generated_at=snap.timestamp;h.snapshots.push(snap);h.snapshots=h.snapshots.slice(-3000);await fs.writeFile(path,JSON.stringify(h,null,2));
