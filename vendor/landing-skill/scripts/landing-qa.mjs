// landing-qa.mjs — the gate every mentor landing/sales page must pass before delivery.
// Run from a dir with playwright (e.g. <landing-repo>): node landing-qa.mjs <url-or-file> [widths...]
// Exit 0 = PASS, 1 = FAIL. Checks per width:
//   overflow      horizontal scroll
//   orphans       a line holding ONE short word (a long URL filling its own line is fine)
//   zeroimg       an image the layout placed that still measures no height (a
//                 responsive variant hidden with display:none is not broken)
//   clipped       content pushed outside the viewport (caught even when overflow:hidden hides the scrollbar)
//   offcenter     (≤640px) a figure/img whose VISIBLE part (what its clipping
//                 frames leave) sits >6px from the viewport centre
//   zeroimg       images with 0 rendered height (broken layout or missing dims)
//   nodims        <img> without width+height attributes (layout shift)
//   smalltext     visible text under 14px
//   touch         a.cta / button / summary / input shorter than 44px
//   css           <hr>, 90deg fading gradients, letter-spacing on a Hebrew page, accent-coloured borders (rough)
//   hidden        .reveal elements still invisible after scrolling (animation fail-safe)
import { chromium } from 'playwright';
import { orphanReport } from './orphanLines.mjs';
import { visibleCentreOffset, CENTRE_TOLERANCE_PX, isBrokenZeroHeight } from './visibleBox.mjs';
const [url,...ws]=process.argv.slice(2); const widths=ws.length?ws.map(Number):[320,360,390,430,768,1280];
const b=await chromium.launch(); let fails=0;
for(const w of widths){ const ctx=await b.newContext({viewport:{width:w,height:900}}); const p=await ctx.newPage();
  await p.goto(url,{waitUntil:'networkidle'});
  await p.evaluate(async()=>{for(let y=0;y<=document.body.scrollHeight+900;y+=300){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,25));}window.scrollTo(0,0);await new Promise(r=>setTimeout(r,1800));});
  const r=await p.evaluate((w)=>{
    const res={};
    res.overflow=document.documentElement.scrollWidth-document.documentElement.clientWidth;res.clipped=[...document.querySelectorAll('p,li,a,pre,code,h1,h2,h3,h4,figcaption,summary,div')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&(b.right>innerWidth+2||b.left<-2)&&getComputedStyle(e).position!=='fixed';}).slice(0,4).map(e=>e.tagName+' ['+Math.round(e.getBoundingClientRect().left)+'..'+Math.round(e.getBoundingClientRect().right)+'] '+(e.textContent||'').trim().slice(0,40));
    const cand=[];document.querySelectorAll('h1,h2,h3,h4,p,li,figcaption,summary,.cta,.quote,.small-h').forEach(h=>{if(!h.offsetParent&&getComputedStyle(h).position!=='fixed')return;if([...h.children].some(c=>{const d=getComputedStyle(c).display;return d==='block'||d==='flex'||d==='grid'||d==='list-item'||d==='table';}))return;const tokens=[];const tw=document.createTreeWalker(h,NodeFilter.SHOW_TEXT);let t;while(t=tw.nextNode()){const re=/\S+/g;let m;while((m=re.exec(t.textContent))){const rr=document.createRange();rr.setStart(t,m.index);rr.setEnd(t,m.index+m[0].length);const rc=rr.getBoundingClientRect();if(!rc.width)continue;tokens.push({text:m[0],top:rc.top,bottom:rc.bottom,width:rc.width});}}cand.push({width:h.getBoundingClientRect().width||1,tokens});});res.orphanCandidates=cand;
    const clipsOf=(el)=>{const out=[];for(let a=el.parentElement;a;a=a.parentElement){const cs=getComputedStyle(a);if(cs.overflow!=='visible'||cs.overflowX!=='visible'){const cb=a.getBoundingClientRect();out.push({left:cb.left,right:cb.right});}}return out;};
    res.offcenterCandidates=w<=640?[...document.querySelectorAll('figure img,.mod-img')].map(i=>{const ib=i.getBoundingClientRect();return {src:(i.getAttribute('src')||'').slice(0,40),rect:{left:ib.left,right:ib.right},clips:clipsOf(i)}}):[];
    res.zeroimgCandidates=[...document.images].map(i=>({src:(i.getAttribute('src')||'').slice(0,40),height:i.getBoundingClientRect().height,laidOut:i.offsetParent!==null||getComputedStyle(i).position==='fixed'}));
    res.nodims=[...document.images].filter(i=>!(i.getAttribute('width')&&i.getAttribute('height'))).length;
    res.smalltext=[...document.querySelectorAll('p,li,span,a,summary,label,figcaption')].filter(e=>e.innerText&&e.innerText.trim()&&e.offsetParent&&parseFloat(getComputedStyle(e).fontSize)<14).length;
    res.touch=[...document.querySelectorAll('a.cta,button,summary,input')].filter(e=>{if(!e.offsetParent)return false;const t=e.closest('label')||e;return t.getBoundingClientRect().height<44;}).length;
    const css=[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules].map(r=>r.cssText)}catch(e){return []}}).join('\n')+[...document.querySelectorAll('[style]')].map(e=>e.getAttribute('style')).join('\n');
    res.css={hr:document.querySelectorAll('hr').length,fade:(css.match(/90deg\s*,\s*transparent/g)||[]).length,tracking:[...document.querySelectorAll('body *')].filter(e=>/[\u0590-\u05FF]/.test(e.textContent||'')&&(ls=>ls!=='normal'&&ls!=='0px')(getComputedStyle(e).letterSpacing)).length};
    res.hidden=[...document.querySelectorAll('.reveal')].filter(e=>getComputedStyle(e).opacity!=='1').length;
    return res;},w);
  r.orphans=r.orphanCandidates.map(orphanReport).filter(Boolean);delete r.orphanCandidates;
  r.offcenter=r.offcenterCandidates.map(c=>({src:c.src,d:visibleCentreOffset(c.rect,c.clips,w)})).filter(o=>o.d!==undefined&&Math.abs(o.d)>CENTRE_TOLERANCE_PX);delete r.offcenterCandidates;
  r.zeroimg=r.zeroimgCandidates.filter(isBrokenZeroHeight).map(c=>c.src);delete r.zeroimgCandidates;
  const bad=r.overflow>0||r.clipped.length||r.orphans.length||r.offcenter.length||r.zeroimg.length||r.nodims||r.smalltext||r.touch||r.css.hr||r.css.fade||r.css.tracking||r.hidden;
  fails+=bad?1:0;
  console.log(`${bad?'FAIL':'PASS'} ${w}px overflow=${r.overflow} clipped=${r.clipped.length} orphans=${r.orphans.length} offcenter=${r.offcenter.length} zeroimg=${r.zeroimg.length} nodims=${r.nodims} smalltext=${r.smalltext} touch<44=${r.touch} hr=${r.css.hr} fade=${r.css.fade} tracking=${r.css.tracking} hidden=${r.hidden}`);
  if(r.clipped.length)r.clipped.forEach(c=>console.log('   clipped:',c)); if(r.orphans.length)r.orphans.forEach(o=>console.log('   orphan:',o)); if(r.offcenter.length)console.log('   offcenter:',JSON.stringify(r.offcenter)); if(r.zeroimg.length)console.log('   zeroimg:',r.zeroimg.join(', '));
  await ctx.close(); }
await b.close(); console.log(fails?`\nRESULT: FAIL (${fails} widths)`:'\nRESULT: PASS'); process.exit(fails?1:0);
