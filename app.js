/* Object Tracking Live - COCO-SSD detections + centroid tracker: persistent IDs, trails, line counting */
(function(){
'use strict';
const video=document.getElementById('cam'),ov=document.getElementById('overlay'),ln=document.getElementById('lineLayer');
const ctx=ov.getContext('2d'),lctx=ln.getContext('2d');
const COLORS=['#0d9488','#2563eb','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#22c55e','#eab308'];
const colorId=id=>COLORS[(id-1)%COLORS.length];
const MAX_AGE_MS=1500,MATCH_DIST=0.22,TRAIL_LEN=40;

let model=null,stream=null,rafId=null,running=false,lastTs=0,fps=0;
let tracks=[],nextId=1,EVENTS=[],crossings=0,chart=null,lineY=0.6,ARCHIVE=[];

function threshold(){return +document.getElementById('rConf').value/100;}
function trailsOn(){return document.getElementById('swTrails').checked;}
function lineOn(){return document.getElementById('swLine').checked;}

async function loadModel(){
  if(model)return model;
  document.getElementById('modelStatus').textContent='Loading model… (~13 MB first time, cached afterwards)';
  model=await cocoSsd.load({base:'lite_mobilenet_v2'});
  document.getElementById('modelStatus').textContent='Model ready - tracking runs entirely on your device ('+tf.getBackend()+' backend).';
  return model;
}
function fitCanvases(){
  const w=video.videoWidth,h=video.videoHeight;
  if(!w)return false;
  if(ov.width!==w){ov.width=ln.width=w;ov.height=ln.height=h;}
  return true;
}

/* ---------- tracker core (pure, testable) ---------- */
function centroid(b){return{x:b[0]+b[2]/2,y:b[1]+b[3]/2};}
function updateTracker(preds,w,h,now){
  const dets=preds.map(p=>{const c=centroid(p.bbox);return{p,cx:c.x,cy:c.y,used:false};});
  const maxD=MATCH_DIST*Math.max(w,h);
  tracks.forEach(t=>t.matched=false);
  dets.forEach(d=>{
    let best=null,bestD=maxD;
    tracks.forEach(t=>{
      if(t.matched)return;
      const dd=Math.hypot(t.cx-d.cx,t.cy-d.cy);
      if(dd<bestD){best=t;bestD=dd;}
    });
    if(best){
      best.matched=true;d.used=true;
      const prevY=best.cy;
      best.cx=best.cx*0.5+d.cx*0.5;best.cy=best.cy*0.5+d.cy*0.5;
      best.bbox=d.p.bbox;best.score=d.p.score;best.lastSeen=now;
      best.votes[d.p.class]=(best.votes[d.p.class]||0)+1;
      best.cls=Object.entries(best.votes).sort((a,b)=>b[1]-a[1])[0][0];
      best.dist+=Math.hypot(d.cx-best.pcx,d.cy-best.pcy);
      best.pcx=best.cx;best.pcy=best.cy;
      best.trail.push({x:best.cx,y:best.cy});
      if(best.trail.length>TRAIL_LEN)best.trail.shift();
      const ly=lineY*h;
      if((prevY<ly&&best.cy>=ly)||(prevY>ly&&best.cy<=ly)){
        const dir=best.cy>=ly?'down':'up';
        crossings++;
        logEvent('#'+best.id+' '+best.cls+' crossed the line '+dir,dir);
      }
    }
  });
  dets.filter(d=>!d.used).forEach(d=>{
    tracks.push({id:nextId++,cls:d.p.class,votes:{[d.p.class]:1},cx:d.cx,cy:d.cy,pcx:d.cx,pcy:d.cy,bbox:d.p.bbox,score:d.p.score,firstSeen:now,lastSeen:now,trail:[{x:d.cx,y:d.cy}],dist:0,matched:true});
    logEvent('#'+(nextId-1)+' '+d.p.class+' entered','enter');
  });
  tracks.filter(t=>!t.matched&&now-t.lastSeen>MAX_AGE_MS).forEach(t=>{
    logEvent('#'+t.id+' '+t.cls+' left after '+((t.lastSeen-t.firstSeen)/1000).toFixed(1)+'s','leave');
    t.gone=true;ARCHIVE.push(t);
    if(ARCHIVE.length>200)ARCHIVE=ARCHIVE.slice(-200);
  });
  tracks=tracks.filter(t=>!t.gone);
}
function logEvent(text,kind){
  if(EVENTS[0]&&EVENTS[0].text===text)return;
  EVENTS.unshift({ts:Date.now(),text,kind});
  if(EVENTS.length>80)EVENTS.length=80;
  renderLog();
}

/* ---------- drawing ---------- */
function draw(){
  ctx.clearRect(0,0,ov.width,ov.height);
  lctx.clearRect(0,0,ln.width,ln.height);
  const h=ov.height,w=ov.width;
  if(lineOn()&&h){
    const y=lineY*h;
    lctx.strokeStyle='#f59e0b';lctx.lineWidth=Math.max(2,w/500);lctx.setLineDash([12,8]);
    lctx.beginPath();lctx.moveTo(0,y);lctx.lineTo(w,y);lctx.stroke();lctx.setLineDash([]);
    lctx.fillStyle='#f59e0b';
    lctx.font='600 '+Math.max(12,Math.round(w/70))+'px Inter,system-ui,sans-serif';
    lctx.fillText('COUNTING LINE',10,y-8);
    lctx.beginPath();lctx.arc(w-24,y,12,0,7);lctx.fill();
  }
  tracks.filter(t=>!t.gone).forEach(t=>{
    const c=colorId(t.id);const[x,y,bw,bh]=t.bbox;
    if(trailsOn()&&t.trail.length>1){
      ctx.strokeStyle=c;ctx.lineWidth=Math.max(1.5,w/600);ctx.globalAlpha=0.55;
      ctx.beginPath();ctx.moveTo(t.trail[0].x,t.trail[0].y);
      t.trail.forEach(p=>ctx.lineTo(p.x,p.y));ctx.stroke();ctx.globalAlpha=1;
    }
    ctx.lineWidth=Math.max(2,w/450);ctx.strokeStyle=c;ctx.strokeRect(x,y,bw,bh);
    const label='#'+t.id+' '+t.cls+' '+Math.round(t.score*100)+'%';
    ctx.font='600 '+Math.max(12,Math.round(w/55))+'px Inter,system-ui,sans-serif';
    const tw=ctx.measureText(label).width+12,th=Math.max(20,Math.round(w/36));
    ctx.fillStyle=c;ctx.fillRect(x,Math.max(0,y-th),tw,th);
    ctx.fillStyle='#fff';ctx.fillText(label,x+6,Math.max(0,y-th)+th-7);
  });
}
function renderTracks(now){
  const live=tracks.filter(t=>!t.gone);
  document.getElementById('pillTracks').textContent=live.length+' track'+(live.length===1?'':'s');
  document.getElementById('kActive').textContent=live.length;
  document.getElementById('kUnique').textContent=nextId-1;
  const dwells=tracks.map(t=>(t.lastSeen-t.firstSeen)/1000);
  document.getElementById('kLongest').textContent=(dwells.length?Math.max(...dwells):0).toFixed(0)+'s';
  document.getElementById('chipCross').textContent=crossings+' crossing'+(crossings===1?'':'s');
  document.getElementById('trackList').innerHTML=live.length?live.map(t=>'<div class="track-card"><span class="badge-dot" style="background:'+colorId(t.id)+'"></span><span class="track-id" style="color:'+colorId(t.id)+'">#'+t.id+'</span><div class="grow"><div class="small" style="font-weight:600">'+esc(t.cls)+' · '+Math.round(t.score*100)+'%</div><small class="muted">'+((now-t.firstSeen)/1000).toFixed(0)+'s in view · '+Math.round(t.dist)+'px travelled</small></div></div>').join(''):'<div class="empty grow"><p class="mb0">No active tracks. Show the camera a person, cup, phone or pet.</p></div>';
}
function renderLog(){
  document.getElementById('logSub').textContent=EVENTS.length+' events';
  const icons={enter:'#22c55e',leave:'#94a3b8',up:'#2563eb',down:'#f59e0b'};
  document.getElementById('logList').innerHTML=EVENTS.length?EVENTS.map(e=>'<div class="det-row"><span class="badge-dot" style="background:'+(icons[e.kind]||'#94a3b8')+'"></span><div class="grow small">'+esc(e.text)+'</div><small class="muted mono">'+new Date(e.ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'</small></div>').join(''):'<div class="empty"><p class="mb0">Events will appear here.</p></div>';
}
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function drawChart(){
  const byCls={};
  ARCHIVE.concat(tracks).forEach(t=>{byCls[t.cls]=(byCls[t.cls]||0)+1;});
  const top=Object.entries(byCls).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if(chart)chart.destroy();
  if(!top.length)return;
  chart=new Chart(document.getElementById('chCls'),{type:'bar',data:{labels:top.map(t=>t[0]),datasets:[{data:top.map(t=>t[1]),backgroundColor:'#0d9488',borderRadius:6,maxBarThickness:36}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:css('--muted'),precision:0},grid:{color:css('--border')}},y:{ticks:{color:css('--ink-2')},grid:{display:false}}}}});
}
/* ---------- main loop ---------- */
async function loop(ts){
  if(!running)return;
  if(lastTs&&ts>lastTs)fps=fps*0.8+(1000/(ts-lastTs))*0.2;
  lastTs=ts;
  if(fitCanvases()&&model){
    const preds=(await model.detect(video)).filter(p=>p.score>=threshold());
    const now=performance.now();
    updateTracker(preds,ov.width,ov.height,now);
    draw();renderTracks(now);
    document.getElementById('pillFps').textContent=fps.toFixed(0)+' fps';
    if(Math.floor(ts/2000)!==Math.floor((ts-50)/2000))drawChart();
  }
  rafId=requestAnimationFrame(loop);
}
document.getElementById('btnWebcam').addEventListener('click',async()=>{
  try{
    await loadModel();
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1280}},audio:false});
    video.srcObject=stream;await video.play();
    document.getElementById('stageHint').classList.add('hidden');
    running=true;document.getElementById('btnStop').disabled=false;document.getElementById('btnWebcam').disabled=true;
    lastTs=0;rafId=requestAnimationFrame(loop);
    toast('Tracking live - show the camera some objects');
  }catch(e){toast(e.name==='NotAllowedError'?'Camera permission denied':'Camera failed: '+e.message);}
});
function stopAll(){
  running=false;if(rafId)cancelAnimationFrame(rafId);rafId=null;
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  document.getElementById('btnStop').disabled=true;document.getElementById('btnWebcam').disabled=false;
  document.getElementById('stageHint').classList.remove('hidden');
  ctx.clearRect(0,0,ov.width,ov.height);lctx.clearRect(0,0,ln.width,ln.height);
}
document.getElementById('btnStop').addEventListener('click',stopAll);

/* counting line drag */
let dragging=false;
function setLine(e){
  const r=ln.getBoundingClientRect();
  lineY=Math.min(0.95,Math.max(0.05,(e.clientY-r.top)/r.height));
}
ln.addEventListener('pointerdown',e=>{dragging=true;ln.setPointerCapture(e.pointerId);setLine(e);});
ln.addEventListener('pointermove',e=>{if(dragging)setLine(e);});
ln.addEventListener('pointerup',()=>dragging=false);

document.getElementById('rConf').addEventListener('input',()=>{document.getElementById('lblConf').textContent=document.getElementById('rConf').value+'%';});
document.getElementById('btnClearLog').addEventListener('click',()=>{EVENTS=[];crossings=0;ARCHIVE=[];tracks=[];nextId=1;renderLog();drawChart();document.getElementById('chipCross').textContent='0 crossings';});
document.addEventListener('themechange',drawChart);
renderLog();
window._test={loadModel,updateTracker,get ARCHIVE(){return ARCHIVE;},get tracks(){return tracks;},get EVENTS(){return EVENTS;},get crossings(){return crossings;},set lineY(v){lineY=v;},get lineY(){return lineY;},centroid};
})();
