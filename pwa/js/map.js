// map.js -- extracted from index.html

import { sqlDb } from './db.js';
import { currentRoom } from './gmcp.js';
import { findPath, walkTo } from './nav.js';
import { stripAnsi } from './ui.js';
// --- state owned by this module ---
export let mapScale=25;
export let mapOffsetX=0;
export let mapOffsetY=0;
export let mapZoom=1;
export let mapOffscreen=null;
export let mapOffscreenCtx=null;
export let mapViewportW=0;
export let mapViewportH=0;
export let mapFullW=0;
export let mapFullH=0;
export let mapRenderScale=1;

// =============================================================================
// MAP
// =============================================================================
export function showFullMap(){
  document.getElementById('fullmap').classList.add('show');
  drawFullMap();
  attachMapHandlers();
}
export function hideFullMap(){ document.getElementById('fullmap').classList.remove('show'); }

export let mapState=null; // cached map data used by interaction handlers
export let mapPinchStartDist=0, mapPinchBaseZoom=1, mapPinchCenter=null, mapPinchBaseOffset={x:0,y:0};
export let mapPanStart=null, mapPanBase={x:0,y:0}, mapPanning=false;
export let mapMousePan=false, mapMouseStart=null;

export function computeMapState(){
  if(!sqlDb) return null;
  const cvs=document.getElementById('fullmap-canvas');
  const parent=cvs.parentElement;
  let viewportW=parent.clientWidth;
  let viewportH=parent.clientHeight;
  if(!viewportW || !viewportH){ viewportW=window.innerWidth; viewportH=window.innerHeight; }
  cvs.width=viewportW; cvs.height=viewportH;

  const areaSelect=document.getElementById('map-area-select');
  let resetPan=false;
  if(areaSelect){
    const prev=areaSelect.value;
    areaSelect.innerHTML='<option value="">All Areas</option>';
    const areasRes=sqlDb.exec("SELECT DISTINCT area FROM rooms ORDER BY area");
    const areas=(areasRes[0]?.values||[]).map(r=>r[0]).filter(Boolean);
    for(const a of areas){
      const opt=document.createElement('option'); opt.value=a; opt.textContent=a;
      if(a===prev) opt.selected=true;
      areaSelect.appendChild(opt);
    }
    areaSelect.onchange=()=>{ mapOffsetX=0; mapOffsetY=0; mapZoom=1; drawFullMap(); };
    if(prev!==(areaSelect.value||'')) resetPan=true;
  }
  if(resetPan){ mapOffsetX=0; mapOffsetY=0; mapZoom=1; }

  const selectedArea=areaSelect?areaSelect.value:null;
  const currentArea=selectedArea || currentRoom.area || null;
  const sql=currentArea ? "SELECT uid,name,exits,x,y,area FROM rooms WHERE area=?" : "SELECT uid,name,exits,x,y,area FROM rooms";
  const params=currentArea?[currentArea]:[];
  const res=sqlDb.exec(sql, params);
  if(!res.length || !res[0].values.length){ return {empty:true, cvs, ctx:cvs.getContext('2d'), currentArea}; }

  const rawRooms=res[0].values.map(r=>({uid:r[0], name:r[1], exits:(r[2]||''), rx:r[3]||0, ry:r[4]||0, area:r[5]||'', dispX:undefined, dispY:undefined, gaardian:false}));
  const roomByUid={};
  for(const r of rawRooms) roomByUid[r.uid]=r;
  const uids=rawRooms.map(r=>r.uid);

  // Prefer stored coordinates (Gaardian or previously computed). Use them when non-zero.
  let coordRoomCount=0;
  for(const r of rawRooms){
    if(r.rx && r.ry){ r.dispX=r.rx; r.dispY=r.ry; r.gaardian=true; coordRoomCount++; }
  }
  const useStoredCoords = coordRoomCount >= Math.max(3, rawRooms.length * 0.3);

  // Build edges from stored exits (UID-based, so lines survive de-duplication/spacing).
  const dirDelta={n:[0,-1],s:[0,1],e:[1,0],w:[-1,0],u:[0,0],d:[0,0]};
  const edges=[];
  if(uids.length){
    const placeholders=uids.map(()=>'?').join(',');
    const exitsRes=sqlDb.exec(`SELECT from_uid, dir, to_uid FROM exits WHERE from_uid IN (${placeholders})`, uids);
    const rows=exitsRes[0]?.values||[];
    for(const [fromUid, dir, toUid] of rows){
      if(!toUid || toUid==='0' || toUid==='?') continue;
      if(roomByUid[toUid]){ edges.push({from:roomByUid[fromUid], to:roomByUid[toUid], dir}); }
    }
  }
  // Remove duplicate edges
  const edgeKey=e=>e.from.uid+'|'+e.to.uid+'|'+e.dir;
  const edgeSet=new Set();
  const uniqEdges=[];
  for(const e of edges){ const k=edgeKey(e); if(!edgeSet.has(k)){ edgeSet.add(k); uniqEdges.push(e); } }

  if(useStoredCoords){
    // For rooms without stored coords but connected to a positioned room, infer a relative position.
    const queue=rawRooms.filter(r=>r.gaardian).slice();
    let qi=0;
    while(qi<queue.length){
      const cur=queue[qi++];
      for(const e of uniqEdges){
        if(e.from!==cur) continue;
        const nb=e.to;
        if(nb.dispX===undefined){
          const d=dirDelta[e.dir]||[0,0];
          nb.dispX=cur.dispX+d[0];
          nb.dispY=cur.dispY+d[1];
          queue.push(nb);
        }
      }
    }
    // Orphans placed in a loose grid to the right/bottom
    let orphanCol=0, orphanRow=0;
    for(const r of rawRooms){
      if(r.dispX===undefined){ r.dispX=orphanCol; r.dispY=orphanRow; orphanCol++; if(orphanCol>6){ orphanCol=0; orphanRow+=2; } }
    }
  } else {
    // BFS from current room (or first) to assign tight relative display coordinates.
    const root=roomByUid[currentRoom.uid] || rawRooms[0];
    root.dispX=0; root.dispY=0;
    const queue=[root];
    let qi=0;
    while(qi<queue.length){
      const cur=queue[qi++];
      for(const e of uniqEdges){
        if(e.from!==cur) continue;
        const nb=e.to;
        if(nb.dispX===undefined){
          const d=dirDelta[e.dir]||[0,0];
          nb.dispX=cur.dispX+d[0];
          nb.dispY=cur.dispY+d[1];
          queue.push(nb);
        }
      }
    }
    // Place orphan components compactly to the right.
    let orphanCol=0;
    for(const r of rawRooms){
      if(r.dispX===undefined){ r.dispX=orphanCol++; r.dispY=0; }
    }
  }

  // Minimal de-duplication: shift overlapping rooms right (grid aligned).
  const used={};
  for(const r of rawRooms){
    let kx=r.dispX, ky=r.dispY, key=kx+','+ky;
    while(used[key] && used[key]!==r.uid){ kx++; key=kx+','+ky; }
    used[key]=r.uid;
    r.dispX=kx; r.dispY=ky;
  }

  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const r of rawRooms){ minX=Math.min(minX,r.dispX); minY=Math.min(minY,r.dispY); maxX=Math.max(maxX,r.dispX); maxY=Math.max(maxY,r.dispY); }
  const w=Math.max(maxX-minX,1), h=Math.max(maxY-minY,1);

  // Cells are wide enough to carry the room's full name rather than a
  // two-letter abbreviation, so they are much wider than they are tall.
  const cellW=124, cellH=19, linePad=6;
  const padX=20, padY=24;
  const autoScale=Math.min(Math.max((viewportW-padX*2)/(w*cellW), 0.55), 1.4);
  const scale=autoScale*mapZoom;
  // Breathing room at the top, in room-heights, so the first row is not tucked
  // under the map header/controls.
  const padTop=Math.round(3.5*cellH*scale)+padY;

  return {cvs, ctx:cvs.getContext('2d'), viewportW, viewportH, rawRooms, roomByUid, edges:uniqEdges, minX, minY, w, h, cellW, cellH, linePad, padX, padY, padTop, autoScale, scale, currentArea};
}

/**
 * Set ctx.font so `text` fits in `maxWidth`, and return the string to draw.
 *
 * Shrinks down to a legibility floor rather than indefinitely; if the name
 * still does not fit at that size it is truncated with an ellipsis, so a very
 * long name degrades instead of overflowing into its neighbours. Tapping a room
 * still shows the untruncated name.
 */
const LABEL_MIN_PX = 7;
export function fitLabel(ctx, text, maxWidth, basePx){
  let size = Math.max(LABEL_MIN_PX, basePx);
  ctx.font = size + 'px sans-serif';
  if(ctx.measureText(text).width <= maxWidth) return text;

  let lo = LABEL_MIN_PX, hi = size;
  while(hi - lo > 0.5){
    const mid = (hi + lo) / 2;
    ctx.font = mid + 'px sans-serif';
    if(ctx.measureText(text).width <= maxWidth) lo = mid; else hi = mid;
  }
  ctx.font = lo + 'px sans-serif';
  if(ctx.measureText(text).width <= maxWidth) return text;

  // Still too wide at the floor -- trim characters until it fits.
  let s = text;
  while(s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

/**
 * Keep the point under the fingers/cursor fixed while zooming.
 *
 * renderMap draws the map into an offscreen canvas using
 *     screen = pad + (cell - min) * cellSize * scale + offset
 * and blits it at (mapOffsetX, mapOffsetY). The zoom handlers used to invent a
 * different transform -- `(viewportW - w*scale)/2 - minX*cellW*scale` -- which
 * mixes a grid-column count with a pixel scale and double-counts the `min`
 * term that the pad already accounts for. It was merely inaccurate while cells
 * were 48px wide; with full-name cells it throws the view badly off.
 *
 * Working in content-space instead makes it exact: the anchor's offset from the
 * padding scales with the zoom, and the padding itself is constant (bar padTop,
 * which is recomputed because it is defined in room-heights).
 */
function anchoredOffset(anchorPx, baseOffset, padOld, padNew, curScale, newScale){
  const content = anchorPx - baseOffset;                 // position within the map image
  const scaled  = padNew + (content - padOld) * (newScale / curScale);
  return anchorPx - scaled;
}

function zoomAbout(cx, cy, baseOffX, baseOffY, curScale, newScale){
  const {cellH, padX, padY} = mapState;
  const padTopFor = (s) => Math.round(3.5 * cellH * s) + padY;
  mapOffsetX = anchoredOffset(cx, baseOffX, padX, padX, curScale, newScale);
  mapOffsetY = anchoredOffset(cy, baseOffY, padTopFor(curScale), padTopFor(newScale), curScale, newScale);
}

export function renderMap(){
  if(!mapState || mapState.empty){
    const cvs=document.getElementById('fullmap-canvas');
    const ctx=cvs.getContext('2d');
    ctx.fillStyle='#0a0a12'; ctx.fillRect(0,0,cvs.width,cvs.height);
    ctx.fillStyle='#6c6c80'; ctx.font='14px sans-serif'; ctx.fillText('No rooms mapped yet.',20,30);
    return;
  }
  const {cvs, ctx, viewportW, viewportH, rawRooms, edges, minX, minY, w, h, cellW, cellH, linePad, padX, padY, padTop, scale, currentArea}=mapState;

  const fullW=Math.max(Math.ceil(w*cellW*scale + padX*2), viewportW);
  const fullH=Math.max(Math.ceil(h*cellH*scale + padTop + padY), viewportH);

  if(!mapOffscreen){ mapOffscreen=document.createElement('canvas'); mapOffscreenCtx=mapOffscreen.getContext('2d'); }
  mapOffscreen.width=fullW; mapOffscreen.height=fullH;
  mapFullW=fullW; mapFullH=fullH; mapRenderScale=scale;

  const octx=mapOffscreenCtx;
  octx.fillStyle='#0a0a12'; octx.fillRect(0,0,fullW,fullH);
  octx.lineWidth=Math.max(1,1.5*scale);
  octx.strokeStyle='#7a9aba';
  octx.fillStyle='#e0e0e0';
  octx.textAlign='center';
  octx.textBaseline='middle';

  const toPx=(x,y)=>({x:padX+(x-minX)*cellW*scale, y:padTop+(y-minY)*cellH*scale});

  // Draw exit lines / U/D stubs.
  octx.lineWidth=Math.max(1, scale);
  octx.strokeStyle='#7a9aba';
  for(const e of edges){
    const a=toPx(e.from.dispX,e.from.dispY);
    const b=toPx(e.to.dispX,e.to.dispY);
    if(e.dir==='u' || e.dir==='d'){
      const halfW=0.5*cellW*scale, halfH=0.5*cellH*scale;
      octx.beginPath();
      if(e.dir==='u'){
        octx.moveTo(a.x+halfW, a.y-halfH);
        octx.lineTo(a.x+halfW+linePad*scale, a.y-halfH-linePad*scale);
      } else {
        octx.moveTo(a.x-halfW, a.y+halfH);
        octx.lineTo(a.x-halfW-linePad*scale, a.y+halfH+linePad*scale);
      }
      octx.stroke();
    } else {
      const d={n:[0,-1],s:[0,1],e:[1,0],w:[-1,0]}[e.dir];
      if(d){
        octx.beginPath();
        octx.moveTo(a.x+0.5*cellW*scale*d[0], a.y+0.5*cellH*scale*d[1]);
        octx.lineTo(b.x-0.5*cellW*scale*d[0], b.y-0.5*cellH*scale*d[1]);
        octx.stroke();
      }
    }
  }

  // Draw rooms as compact colored cells, Fado-style.
  const roomList=[];
  let here=null;
  for(const r of rawRooms){
    const p=toPx(r.dispX,r.dispY);
    const isCurrent=currentRoom.uid && r.uid===currentRoom.uid;
    const bw=cellW*scale-1, bh=cellH*scale-1;
    const rx=p.x-bw/2, ry=p.y-bh/2;
    // The current room is drawn again after this loop so that nothing painted
    // later can sit on top of it.
    if(isCurrent){ here={p, rx, ry, bw, bh, r}; }
    octx.fillStyle='#1a1a2e';
    octx.fillRect(rx,ry,bw,bh);
    octx.strokeStyle='#7a9aba';
    octx.lineWidth=Math.max(1,0.8*scale);
    octx.strokeRect(rx,ry,bw,bh);
    // The room's full name, shrunk to fit the cell. This replaces the old
    // two-letter abbreviation; cells are sized for it (see cellW above).
    octx.fillStyle='#c3d3e2';
    octx.textAlign='center';
    octx.textBaseline='middle';
    const label=fitLabel(octx, stripAnsi(r.name||'').trim() || '?', bw-6, Math.min(11, 10*scale));
    octx.fillText(label, p.x, p.y);
    roomList.push({x:p.x,y:p.y,w:bw,h:bh,r:r});
  }

  // "You are here", drawn last and drawn loudly.
  //
  // This cell used to be filled with `var(--green)`. Canvas does not resolve CSS
  // custom properties, and an invalid fillStyle assignment is silently ignored --
  // so the current room was painted #1a1a2e like every other room and the only
  // thing marking it was a white border.
  if(here){
    const {p, rx, ry, bw, bh}=here;
    const pad=Math.max(3, 2.5*scale);
    octx.save();
    // Halo, so the room is findable without hunting for it.
    octx.shadowColor='rgba(46,204,113,.9)';
    octx.shadowBlur=Math.max(8, 10*scale);
    octx.fillStyle='#2ecc71';
    octx.fillRect(rx,ry,bw,bh);
    octx.shadowBlur=0;
    // Bright ring standing off the cell, plus a crisp inner edge.
    octx.strokeStyle='#2ecc71';
    octx.lineWidth=Math.max(2,1.5*scale);
    octx.strokeRect(rx-pad, ry-pad, bw+pad*2, bh+pad*2);
    octx.strokeStyle='#ffffff';
    octx.lineWidth=Math.max(2,1.8*scale);
    octx.strokeRect(rx,ry,bw,bh);
    // Label in black bold: green on dark text is unreadable.
    octx.fillStyle='#000';
    octx.textAlign='center';
    octx.textBaseline='middle';
    // fitLabel picks a size that fits and leaves it on ctx.font; keep that size
    // and only add the weight, or bold text overflows the cell. Slightly tighter
    // budget than the normal cells, since bold is wider.
    const label=fitLabel(octx, stripAnsi(here.r.name||'').trim() || '?', bw-9, Math.min(11, 10*scale));
    octx.font='bold '+octx.font;
    octx.fillText(label, p.x, p.y);
    octx.restore();
  }
  mapState.roomList=roomList;

  // Clamp pan.
  if(mapFullW<=mapViewportW) mapOffsetX=(mapViewportW-mapFullW)/2;
  else mapOffsetX=Math.min(0, Math.max(mapOffsetX, mapViewportW-mapFullW));
  if(mapFullH<=mapViewportH) mapOffsetY=(mapViewportH-mapFullH)/2;
  else mapOffsetY=Math.min(0, Math.max(mapOffsetY, mapViewportH-mapFullH));

  // Blit offscreen to visible canvas.
  ctx.fillStyle='#0a0a12'; ctx.fillRect(0,0,viewportW,viewportH);
  ctx.drawImage(mapOffscreen, mapOffsetX, mapOffsetY);

  // Header stays fixed to viewport.
  ctx.fillStyle='#6c6c80';
  ctx.textAlign='left';
  ctx.textBaseline='alphabetic';
  ctx.font='12px monospace';
  ctx.fillText((currentArea||'All Areas')+' — '+rawRooms.length+' rooms',10,22);
}

export function drawFullMap(){
  mapState=computeMapState();
  renderMap();
  attachMapHandlers();
}

export function mapHitTest(cx,cy){
  if(!mapState || !mapState.roomList) return null;
  let best=null, bestDist=Infinity;
  for(const item of mapState.roomList){
    const halfW=item.w/2, halfH=item.h/2;
    const dx=Math.max(0, Math.abs(cx-item.x-mapOffsetX)-halfW);
    const dy=Math.max(0, Math.abs(cy-item.y-mapOffsetY)-halfH);
    const d=Math.sqrt(dx*dx+dy*dy);
    if(d<bestDist){ bestDist=d; best=item; }
  }
  return best && bestDist<30*mapRenderScale ? best : null;
}

// Tap-to-walk. This used to run its own BFS over the rendered map edges (with
// the same broken reverse-direction fallback as the other three copies) and
// then fire the whole path with setTimeout every 400ms -- into a 500ms throttle
// that silently swallowed roughly every second step. Both jobs now belong to
// nav.js, which paces on GMCP room.info confirmations.
export function mapGotoRoom(targetUid){
  if(!mapState || mapState.empty) return;
  const target=mapState.rawRooms.find(r=>r.uid===targetUid);
  if(!target) return;
  const mapInfo=document.getElementById('map-info');
  const say=(msg)=>{ if(mapInfo) mapInfo.innerHTML='<span>'+target.name+'</span> — '+msg; };

  if(currentRoom.uid===targetUid){ say('already here'); return; }
  const path=findPath(currentRoom.uid, targetUid);
  if(path===null){ say('no path found'); return; }
  if(!path.length){ say('already here'); return; }

  say('moving ' + path.map(n=>n.dir.length>1?n.dir:n.dir.toUpperCase()).join(' '));
  walkTo(targetUid,
    ()=>say('arrived'),
    (reason)=>say('stopped: '+reason));
}

export function showRoomDetails(item){
  const mapInfo=document.getElementById('map-info');
  if(!mapInfo) return;
  const isCurrent=currentRoom.uid && item.r.uid===currentRoom.uid;
  let html='<span>'+item.r.name+'</span>';
  if(item.r.exits) html+=' <br>Exits: '+item.r.exits.split(':').join(', ').toUpperCase();
  if(!isCurrent){
    html+=' <button id="map-go" style="margin-left:8px;background:var(--green);color:#000;border:none;padding:3px 8px;border-radius:4px;font-size:12px;">Go</button>';
  }
  mapInfo.innerHTML=html;
  const btn=document.getElementById('map-go');
  if(btn) btn.onclick=function(e){ e.stopPropagation(); mapGotoRoom(item.r.uid); };
}

export function attachMapHandlers(){
  const cvs=document.getElementById('fullmap-canvas');
  if(!cvs || cvs._mapHandlers) return;
  cvs._mapHandlers=true;
  const mapInfo=document.getElementById('map-info');

  cvs.onclick=function(e){
    const rect=cvs.getBoundingClientRect();
    const best=mapHitTest(e.clientX-rect.left, e.clientY-rect.top);
    if(best) showRoomDetails(best);
  };

  cvs.ondblclick=function(e){
    const rect=cvs.getBoundingClientRect();
    const best=mapHitTest(e.clientX-rect.left, e.clientY-rect.top);
    if(best) mapGotoRoom(best.r.uid);
  };

  cvs.ontouchstart=function(e){
    if(e.touches.length===1){
      const t=e.touches[0];
      mapPanStart={x:t.clientX,y:t.clientY,time:Date.now()};
      mapPanBase={x:mapOffsetX,y:mapOffsetY};
      mapPanning=false;
    } else if(e.touches.length===2){
      mapPanStart=null; mapPanning=false;
      const t0=e.touches[0], t1=e.touches[1];
      mapPinchStartDist=Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
      mapPinchBaseZoom=mapZoom;
      mapPinchCenter={x:(t0.clientX+t1.clientX)/2, y:(t0.clientY+t1.clientY)/2};
      mapPinchBaseOffset={x:mapOffsetX, y:mapOffsetY};
    }
  };

  cvs.ontouchmove=function(e){
    if(e.touches.length===1 && mapPanStart){
      const t=e.touches[0];
      const dx=t.clientX-mapPanStart.x, dy=t.clientY-mapPanStart.y;
      if(Math.sqrt(dx*dx+dy*dy)>8) mapPanning=true;
      if(mapPanning){
        mapOffsetX=mapPanBase.x+dx;
        mapOffsetY=mapPanBase.y+dy;
        renderMap(); // fast blit, no DB recompute
      }
    } else if(e.touches.length===2){
      e.preventDefault();
      const t0=e.touches[0], t1=e.touches[1];
      const dist=Math.hypot(t1.clientX-t0.clientX, t1.clientY-t0.clientY);
      if(mapPinchStartDist>0 && mapState && !mapState.empty){
        const newZoom=Math.min(Math.max(mapPinchBaseZoom*(dist/mapPinchStartDist), 0.5), 4);
        const {autoScale}=mapState;
        const rect=cvs.getBoundingClientRect();
        const cx=mapPinchCenter.x-rect.left, cy=mapPinchCenter.y-rect.top;
        const curScale=autoScale*mapPinchBaseZoom;
        mapZoom=newZoom;
        zoomAbout(cx, cy, mapPinchBaseOffset.x, mapPinchBaseOffset.y, curScale, autoScale*mapZoom);
        drawFullMap(); // recompute + render at new zoom
      }
    }
    e.preventDefault();
  };

  cvs.ontouchend=function(e){
    if(mapPanStart && !mapPanning){
      const rect=cvs.getBoundingClientRect();
      const best=mapHitTest(mapPanStart.x-rect.left, mapPanStart.y-rect.top);
      if(best) showRoomDetails(best);
    }
    mapPanStart=null; mapPanning=false;
  };

  cvs.onmousedown=function(e){ mapMousePan=true; mapMouseStart={x:e.clientX,y:e.clientY}; mapPanBase={x:mapOffsetX,y:mapOffsetY}; };
  cvs.onmousemove=function(e){
    if(mapMousePan && mapMouseStart){
      mapOffsetX=mapPanBase.x+(e.clientX-mapMouseStart.x);
      mapOffsetY=mapPanBase.y+(e.clientY-mapMouseStart.y);
      renderMap();
    }
  };
  cvs.onmouseup=function(){ mapMousePan=false; mapMouseStart=null; };
  cvs.onmouseleave=function(){ mapMousePan=false; mapMouseStart=null; };

  cvs.onwheel=function(e){
    e.preventDefault();
    if(!mapState || mapState.empty) return;
    const {autoScale}=mapState;
    const rect=cvs.getBoundingClientRect();
    const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
    const zoomFactor=e.deltaY<0?1.15:0.87;
    const newZoom=Math.min(Math.max(mapZoom*zoomFactor, 0.5), 4);
    const oldScale=autoScale*mapZoom, newScale=autoScale*newZoom;
    mapZoom=newZoom;
    zoomAbout(cx, cy, mapOffsetX, mapOffsetY, oldScale, newScale);
    drawFullMap();
  };
}
