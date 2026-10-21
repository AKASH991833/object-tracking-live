import puppeteer from 'puppeteer-core';
import fs from 'fs';
const out='/tmp/shots55';fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
let fails=[];
const check=(name,ok,extra='')=>{console.log((ok?'PASS':'FAIL')+' '+name+(extra?' — '+extra:''));if(!ok)fails.push(name);};
for(const v of [{name:'desktop',w:1440,h:900},{name:'mobile',w:390,h:844}]){
 for(const theme of ['light','dark']){
  console.log('--- '+v.name+'/'+theme);
  const page=await browser.newPage();
  await page.setViewport({width:v.w,height:v.h,deviceScaleFactor:1});
  const errs=[];page.on('pageerror',e=>errs.push(String(e)));page.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  await page.evaluateOnNewDocument(t=>localStorage.setItem('theme',t),theme);
  await page.goto('http://localhost:8057',{waitUntil:'networkidle2'});

  // --- deterministic tracker tests via _test hooks ---
  const tr=await page.evaluate(()=>{
    const T=window._test,r={};
    const W=640,H=480;T.lineY=0.6; // ly=288
    T.updateTracker([{class:'person',score:0.9,bbox:[100,100,50,100]}],W,H,1000);
    r.oneTrack=T.tracks.length===1&&T.tracks[0].id===1;
    r.enterEvt=T.EVENTS.some(e=>e.text.includes('#1 person entered'));
    T.updateTracker([{class:'person',score:0.9,bbox:[110,105,50,100]}],W,H,1100);
    r.persistent=T.tracks.length===1&&T.tracks[0].id===1&&T.tracks[0].trail.length===2;
    T.updateTracker([{class:'cup',score:0.8,bbox:[400,300,40,40]}],W,H,1200);
    r.twoTracks=T.tracks.length===2&&T.tracks[1].id===2;
    // walk the person down across the line (steps < match distance 140px, EMA needs a few steps)
    T.updateTracker([{class:'person',score:0.9,bbox:[110,200,50,100]}],W,H,1300);
    T.updateTracker([{class:'person',score:0.9,bbox:[110,270,50,100]}],W,H,1400);
    T.updateTracker([{class:'person',score:0.9,bbox:[110,340,50,100]}],W,H,1500);
    r.crossed=T.crossings===1&&T.EVENTS.some(e=>e.text.includes('#1 person crossed the line down'));
    r.cupNotCrossed=!T.EVENTS.some(e=>e.text.includes('#2 cup crossed'));
    // class flicker resolves to most-seen class
    T.updateTracker([{class:'chair',score:0.7,bbox:[105,345,50,100]}],W,H,1600);
    r.classStable=T.tracks.find(t=>t.id===1).cls==='person';
    // everything leaves
    T.updateTracker([],W,H,6000);
    r.exits=T.tracks.length===0&&T.EVENTS.filter(e=>e.kind==='leave').length===2;
    r.archived=T.ARCHIVE.length===2;
    document.dispatchEvent(new CustomEvent('themechange'));
    return r;
  });
  for(const[k,val]of Object.entries(tr))check(`${v.name}/${theme} tracker ${k}`,val===true,JSON.stringify(tr));

  // --- webcam pipeline smoke test with the real model ---
  await page.evaluate(()=>document.getElementById('btnClearLog').click());
  await page.evaluate(()=>document.getElementById('btnWebcam').click());
  await page.waitForFunction(()=>document.getElementById('modelStatus').textContent.includes('Model ready'),{timeout:120000});
  await page.waitForFunction(()=>/\d+ fps/.test(document.getElementById('pillFps').textContent),{timeout:30000});
  const sized=await page.evaluate(()=>{const o=document.getElementById('overlay');return o.width>300&&o.height>200;});
  check(`${v.name}/${theme} webcam loop running, overlay sized`,sized);
  const stopEn=await page.$eval('#btnStop',e=>!e.disabled);
  check(`${v.name}/${theme} stop enabled while tracking`,stopEn);
  // counting line drag
  await page.evaluate(()=>{const l=document.getElementById('lineLayer');const r=l.getBoundingClientRect();
    l.dispatchEvent(new PointerEvent('pointerdown',{clientY:r.top+r.height*0.8,bubbles:true,pointerId:1}));
    l.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1}));});
  await new Promise(s=>setTimeout(s,300));
  const ly=await page.evaluate(()=>window._test.lineY);
  check(`${v.name}/${theme} line draggable`,Math.abs(ly-0.8)<0.08,'lineY='+ly.toFixed(2));
  await page.evaluate(()=>document.getElementById('btnStop').click());
  await new Promise(s=>setTimeout(s,300));
  const stopped=await page.$eval('#btnStop',e=>e.disabled);
  check(`${v.name}/${theme} stop halts tracking`,stopped);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:`${out}/top-${v.name}-${theme}.png`});
  await page.evaluate(()=>document.getElementById('stats').scrollIntoView({block:'start'}));
  await new Promise(s=>setTimeout(s,300));
  await page.screenshot({path:`${out}/stats-${v.name}-${theme}.png`});
  check(`${v.name}/${theme} no console errors`,errs.length===0,errs.slice(0,3).join('|'));
  await page.close();
 }
}
await browser.close();
if(fails.length){console.log('\nFAILURES: '+fails.join(', '));process.exit(1);}
console.log('\nALL PASS');
