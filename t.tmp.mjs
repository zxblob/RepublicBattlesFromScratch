import WebSocket from "ws";
const mk=()=>new Promise(r=>{const ws=new WebSocket("ws://localhost:3555/ws");const o={ws,msgs:[],tok:null};ws.on("message",m=>{const j=JSON.parse(m);o.msgs.push(j);if(j.t==="joined")o.tok=j;});ws.on("open",()=>r(o));});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const send=(o,m)=>o.ws.send(JSON.stringify(m));
const last=(o,t)=>[...o.msgs].reverse().find(m=>m.t===t);
// 1. publish map
const png = {name:"Test",w:96,h:64,rle:[0,96*20, 1,96*30, 2,96*4, 0,96*10]};
let res=await fetch("http://localhost:3555/api/maps",{method:"POST",body:JSON.stringify(png)}); const mapRes=await res.text(); console.log("map upload",res.status,mapRes);
const code=JSON.parse(mapRes).code;
// 2. huge ww solo
let a=await mk(); const t0=Date.now();
send(a,{t:"solo",name:"A",setup:{mode:"ww",teams:2,bots:30,size:"huge",islands:false,map:""}});
await sleep(4000);
const st=last(a,"start"); console.log("huge start", !!st, st&&st.w, st&&st.h, "ms",Date.now()-t0, "ticks", a.msgs.filter(m=>m.t==="tick").length, "terrainRuns", st&&st.terrain.length, "mode",st&&st.mode,"phase",st&&st.phase);
const tick=last(a,"tick"); console.log("tick me", JSON.stringify(tick&&tick.me), "ph", tick&&tick.ph);
send(a,{t:"ready"}); await sleep(500);
send(a,{t:"save"}); await sleep(800);
console.log("saved?", !!last(a,"saved"));
const roomCode=last(a,"joined").code, token=last(a,"joined").token;
a.ws.close(); await sleep(300);
// 3. team mode custom map
let b=await mk(); send(b,{t:"solo",name:"B",setup:{mode:"team",teams:2,bots:3,size:"small",islands:false,map:code}}); await sleep(1500);
const sb=last(b,"start"); console.log("custom", sb&&sb.w,sb&&sb.h,sb&&sb.players.map(p=>p.team).join(","), last(b,"error"));
// 4. skin
send(b,{t:"skin",data:"data:image/png;base64,iVBORw0KGgo="}); await sleep(400);
console.log("skin err", JSON.stringify(last(b,"error")));
console.log("RESUME code",roomCode,token);
process.stdout.write("");
import fs from "node:fs"; fs.writeFileSync("/tmp/rbt/resume.json",JSON.stringify({roomCode,token}));
process.exit(0);
