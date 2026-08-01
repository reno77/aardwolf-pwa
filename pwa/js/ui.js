// ui.js -- extracted from index.html

import { fadoTriggers, persistDb, persistDbNow, replaceDb, sqlDb } from './db.js';
import { renderRooms } from './nav.js';
import { connected, sendCmd, showLogin, ws } from './net.js';
import { parseCampaignOutput, parseCpCheckOutput, parseCpInfoOutput, parseCpStatusOutput, renderCampaign } from './snd.js';
import { commandMap, output, triggerDefs } from './state.js';
// --- state owned by this module ---
export let triggered=new Set();
export let triggersEnabled=true;
export let questTarget='';
export let questArea='';
export let swipePanelState=0; // 0=rooms,1=aliases,2=triggers,3=campaign
export let lineCount=0;
export let maxLines=parseInt(localStorage.getItem('buffer_lines'))||200;

// =============================================================================
// OUTPUT
// =============================================================================
function emitLine(line, cls){
  const div=document.createElement('div');
  div.className='line '+(cls||'');
  div.innerHTML=ansiToHtml(line);
  output.appendChild(div);
  if(++lineCount>maxLines){output.removeChild(output.firstChild);lineCount--;}
}

// MUD output arrives in arbitrary TCP-sized chunks, so a single line is often
// split across two of them, and a chunk ending in a newline used to yield a
// trailing empty string from split() -- rendered as a blank row. Between them
// that put a spurious gap after most lines and broke ASCII maps into double
// height. Hold the incomplete tail back and emit only whole lines.
let pendingLine='';
let pendingTimer=null;

export function appendOutput(text,cls){
  if(text==null) return;
  let s=String(text).replace(/\r\n/g,'\n').replace(/\r/g,'');

  if(cls){
    // Client-generated message: flush any partial MUD line first so ordering
    // stays honest, then print it as-is.
    flushPending();
    s=s.replace(/\n+$/,'');
    for(const line of s.split('\n')) emitLine(line, cls);
  } else {
    s=pendingLine+s;
    const nl=s.lastIndexOf('\n');
    if(nl<0){
      pendingLine=s;
      schedulePendingFlush();   // a prompt has no trailing newline
      return;
    }
    pendingLine=s.slice(nl+1);
    for(const line of s.slice(0,nl).split('\n')) emitLine(line, cls);
    if(pendingLine) schedulePendingFlush();
  }
  output.scrollTop=output.scrollHeight;
}

function flushPending(){
  if(pendingTimer){ clearTimeout(pendingTimer); pendingTimer=null; }
  if(!pendingLine) return;
  const line=pendingLine;
  pendingLine='';
  emitLine(line, '');
}

// Aardwolf's prompt arrives without a trailing newline, so it would sit in the
// buffer forever. Flush shortly after the stream goes quiet.
function schedulePendingFlush(){
  if(pendingTimer) clearTimeout(pendingTimer);
  pendingTimer=setTimeout(()=>{
    pendingTimer=null;
    flushPending();
    output.scrollTop=output.scrollHeight;
  }, 120);
}

// Accessors for state owned here but changed from other modules. Imported
// bindings are read-only, so the write has to happen in the owning module.
export function clearOutput(){ output.innerHTML=''; lineCount=0; }

export function setMaxLines(n){
  maxLines=Math.max(50,Math.min(2000,parseInt(n)||200));
  localStorage.setItem('buffer_lines',maxLines);
  return maxLines;
}

export function setTriggersEnabled(v){ triggersEnabled=!!v; }

export function ansiToHtml(t){
  t=t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  let r='',curCls='',buf='';
  let inEsc=false,esc='';
  function flush(){
    if(!buf) return;
    if(curCls) r+='<span class="'+curCls+'">'+buf+'</span>';
    else r+=buf;
    buf='';
  }
  for(let i=0;i<t.length;i++){
    const ch=t[i];
    if(ch==='\x1b'){flush();inEsc=true;esc='';continue;}
    if(inEsc){
      esc+=ch;
      if(/[a-zA-Z]/.test(ch)){
        const codes=esc.slice(1,-1).split(';').filter(x=>x);
        let cls=[];
        for(const c of codes){
          if(c==='0') cls=[];
          else if(c==='1') cls.push('cb');
          else if(c==='4') cls.push('cu');
          else if(/^3\d$|^9\d$/.test(c)) cls.push('c'+c);
          else if(/^4\d$|^10\d$/.test(c)) cls.push('c'+c);
        }
        const newCls=cls.join(' ');
        if(newCls!==curCls){flush();curCls=newCls;}
        inEsc=false;esc='';continue;
      }
      continue;
    }
    buf+=ch;
  }
  flush();
  return r;
}

export function stripAnsi(t){return t.replace(/\x1b\[[0-9;]*m/g,'');}

// =============================================================================
// TRIGGERS
// =============================================================================
export function processTriggers(text){
  if(!triggersEnabled) return;
  const cleanText=stripAnsi(text);
  // Built-in triggers (login, auto-wake, etc.)
  for(const t of triggerDefs){
    if(!t.enabled) continue;
    if(t.once&&triggered.has(t.name)) continue;
    if(t.p.test(cleanText)){
      triggered.add(t.name);
      // Special handling for login triggers
      if(t.cmd==='auto_name'){
        const savedName=localStorage.getItem('aard_name');
        if(savedName && savedName.trim()){
          if(ws && connected){
            ws.send(JSON.stringify({cmd:savedName.trim()}));
            appendOutput('[Auto-login] Sending name...\n','system');
          }
        } else {
          showLogin();
        }
        continue;
      }
      if(t.cmd==='auto_pass'){
        const savedPass=localStorage.getItem('aard_pass');
        if(savedPass && savedPass.trim()){
          try {
            const pass=atob(savedPass.trim());
            // Delay password by 1.5s so MUD processes name first
            setTimeout(()=>{
              if(ws && connected){
                ws.send(JSON.stringify({cmd:pass}));
                appendOutput('[Auto-login] Sending password...\n','system');
              }
            }, 1500);
          } catch(e){ setTimeout(()=>showLogin(), 1500); }
        } else {
          setTimeout(()=>showLogin(), 1500);
        }
        continue;
      }
      sendCmd(t.cmd);
      appendOutput('[Auto] '+t.name+': '+t.cmd+'\n','trigger');
    }
  }
  // Fado triggers (combat, status, utility)
  for(const t of fadoTriggers){
    if(!t.enabled) continue;
    if(t.p.test(cleanText)){
      sendCmd(t.cmd);
      appendOutput('[Trig] '+t.name+': '+t.cmd+'\n','trigger');
    }
  }
}

export function checkQuest(text){
  const clean=stripAnsi(text);
  // Standard quest assignment
  const patterns=[
    /You have been tasked to kill\s+(.+?)\s+in\s+the\s+area of\s+(.+?)\./i,
    /Go kill\s+(.+?)\s+in\s+the\s+area of\s+(.+?)\./i,
    /Find and kill\s+(.+?)\s+near\s+(.+?)\./i,
    /Find and kill\s+(.+?)\s+in\s+(.+?)\./i,
    /You have been asked to kill\s+(.+?)\s+in\s+(.+?)\./i,
    /Quest: kill\s+(.+?)\s+in\s+(.+?)\./i,
  ];
  for(const p of patterns){
    const m=clean.match(p);
    if(m){
      questTarget=m[1].trim(); questArea=m[2].trim();
      document.getElementById('quest-target').textContent=questTarget;
      document.getElementById('quest-area').textContent=questArea;
      document.getElementById('quest-info').style.display='block';
      appendOutput('Quest: '+questTarget+' in '+questArea+'\n','quest');
      try{if('vibrate' in navigator && document.getElementById('trig-vibrate').checked) navigator.vibrate(200);}catch(e){}
      return;
    }
  }
  // Campaign / S&D output parsing
  parseCampaignOutput(text);
  parseCpInfoOutput(text);
  parseCpCheckOutput(text);
  parseCpStatusOutput(text);
}


// =============================================================================
// ALIAS PANEL
// =============================================================================
export function renderAliases(){
  const q=document.getElementById('alias-search').value.toLowerCase();
  const list=document.getElementById('alias-list');
  list.innerHTML='';
  // commandMap aliases (editable), sorted alphabetically
  const names=Object.keys(commandMap).sort((a,b)=>a.localeCompare(b));
  for(const name of names){
    const exp=commandMap[name];
    if(q && !name.includes(q)) continue;
    const el=document.createElement('div');
    el.className='item';
    el.style.display='flex';
    el.style.justifyContent='space-between';
    el.style.alignItems='center';
    el.innerHTML='<span><b>'+name+'</b> = '+exp.substring(0,40)+(exp.length>40?'...':'')+'</span><button onclick="editAlias(\''+name+'\')" style="background:var(--blue);color:#fff;padding:2px 8px;font-size:11px;border-radius:3px;">Edit</button>';
    list.appendChild(el);
  }
}

export let editingAliasName='';
export function newAlias(){ editingAliasName=''; document.getElementById('ed-alias-name').value=''; document.getElementById('ed-alias-cmd').value=''; document.getElementById('alias-editor').style.display='block'; }
export function editAlias(name){ editingAliasName=name; document.getElementById('ed-alias-name').value=name; document.getElementById('ed-alias-cmd').value=commandMap[name]||''; document.getElementById('alias-editor').style.display='block'; }
export function cancelAliasEdit(){ document.getElementById('alias-editor').style.display='none'; }
export function saveAliasEdit(){
  const name=document.getElementById('ed-alias-name').value.trim().toLowerCase();
  const cmd=document.getElementById('ed-alias-cmd').value.trim();
  if(!name||!cmd){ appendOutput('Alias needs name and commands.\n','error'); return; }
  // Delete old if renaming
  if(editingAliasName && editingAliasName!==name) delete commandMap[editingAliasName];
  commandMap[name]=cmd;
  // Persist to DB if available
  if(sqlDb){
    sqlDb.run("INSERT OR REPLACE INTO aliases(name, expansion) VALUES (?,?)",[name,cmd]);
    persistDb();
  }
  document.getElementById('alias-editor').style.display='none';
  renderAliases();
  appendOutput('Alias saved: '+name+'\n','system');
}
export function deleteAliasEdit(){
  if(!editingAliasName){ cancelAliasEdit(); return; }
  delete commandMap[editingAliasName];
  if(sqlDb){ sqlDb.run("DELETE FROM aliases WHERE name=?",[editingAliasName]); persistDb(); }
  document.getElementById('alias-editor').style.display='none';
  renderAliases();
  appendOutput('Alias deleted: '+editingAliasName+'\n','system');
}
export function exportAliases(){
  const data=JSON.stringify(commandMap,null,2);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download='aliases.json'; a.click();
  URL.revokeObjectURL(url);
  appendOutput('Aliases exported.\n','system');
}

// =============================================================================
// TRIGGER PANEL
// =============================================================================
export function renderTriggers(){
  const list=document.getElementById('trigger-list');
  list.innerHTML='';
  // Built-in triggers (read-only)
  const builtinHeader=document.createElement('div');
  builtinHeader.innerHTML='<b style="color:var(--green)">Built-in</b>';
  list.appendChild(builtinHeader);
  for(const t of triggerDefs){
    const el=document.createElement('div');
    el.className='item';
    el.innerHTML='<input type="checkbox" '+(t.enabled?'checked':'')+' onchange="triggerDefs.find(x=>x.name==\''+t.name+'\').enabled=this.checked"> <b>'+t.name+'</b> → '+t.cmd;
    list.appendChild(el);
  }
  // Fado triggers (editable)
  const fado = fadoTriggers.filter(t => t.name.startsWith('fado_'));
  if(fado.length){
    const fadoHeader=document.createElement('div');
    fadoHeader.innerHTML='<b style="color:var(--yellow);margin-top:8px;display:block">Fado Triggers ('+fado.length+')</b>';
    list.appendChild(fadoHeader);
    for(const t of fado){
      const el=document.createElement('div');
      el.className='item';
      el.style.fontSize='12px';
      el.style.display='flex';
      el.style.justifyContent='space-between';
      el.style.alignItems='center';
      el.innerHTML='<span><input type="checkbox" '+(t.enabled?'checked':'')+' onchange="toggleTrigger(\''+t.name+'\')"> <b>'+t.name.replace('fado_','')+'</b> → '+t.cmd.substring(0,25)+(t.cmd.length>25?'...':'')+'</span><button onclick="editTrigger(\''+t.name+'\')" style="background:var(--blue);color:#fff;padding:2px 8px;font-size:11px;border-radius:3px;">Edit</button>';
      list.appendChild(el);
    }
  }
  // User custom triggers (editable)
  const custom = fadoTriggers.filter(t => !t.name.startsWith('fado_'));
  if(custom.length){
    const customHeader=document.createElement('div');
    customHeader.innerHTML='<b style="color:var(--blue);margin-top:8px;display:block">Custom ('+custom.length+')</b>';
    list.appendChild(customHeader);
    for(const t of custom){
      const el=document.createElement('div');
      el.className='item';
      el.style.fontSize='12px';
      el.style.display='flex';
      el.style.justifyContent='space-between';
      el.style.alignItems='center';
      el.innerHTML='<span><input type="checkbox" '+(t.enabled?'checked':'')+' onchange="toggleTrigger(\''+t.name+'\')"> <b>'+t.name+'</b> → '+t.cmd.substring(0,25)+(t.cmd.length>25?'...':'')+'</span><button onclick="editTrigger(\''+t.name+'\')" style="background:var(--blue);color:#fff;padding:2px 8px;font-size:11px;border-radius:3px;">Edit</button>';
      list.appendChild(el);
    }
  }
}

export let editingTriggerName='';
export function newTrigger(){ editingTriggerName=''; document.getElementById('ed-trig-name').value=''; document.getElementById('ed-trig-pattern').value=''; document.getElementById('ed-trig-cmd').value=''; document.getElementById('trigger-editor').style.display='block'; }
export function editTrigger(name){ editingTriggerName=name; const t=fadoTriggers.find(x=>x.name===name); if(!t)return; document.getElementById('ed-trig-name').value=name; document.getElementById('ed-trig-pattern').value=t.p.source; document.getElementById('ed-trig-cmd').value=t.cmd; document.getElementById('trigger-editor').style.display='block'; }
export function cancelTriggerEdit(){ document.getElementById('trigger-editor').style.display='none'; }
export function saveTriggerEdit(){
  const name=document.getElementById('ed-trig-name').value.trim();
  const pattern=document.getElementById('ed-trig-pattern').value.trim();
  const cmd=document.getElementById('ed-trig-cmd').value.trim();
  if(!name||!pattern||!cmd){ appendOutput('Trigger needs name, pattern, and command.\n','error'); return; }
  let regex;
  try{ regex=new RegExp(pattern,'i'); }catch(e){ appendOutput('Invalid regex: '+e+'\n','error'); return; }
  // Update or create
  const existing=fadoTriggers.findIndex(x=>x.name===name);
  if(existing>=0){
    fadoTriggers[existing]={name:name, enabled:true, p:regex, cmd:cmd};
  } else {
    fadoTriggers.push({name:name, enabled:true, p:regex, cmd:cmd});
  }
  // Persist to DB
  if(sqlDb){
    sqlDb.run("INSERT OR REPLACE INTO triggers(name, enabled, pattern, cmd, category) VALUES (?,?,?,?,?)",[name,1,regex.source,cmd,'custom']);
    persistDb();
  }
  document.getElementById('trigger-editor').style.display='none';
  renderTriggers();
  appendOutput('Trigger saved: '+name+'\n','system');
}
export function deleteTriggerEdit(){
  if(!editingTriggerName){ cancelTriggerEdit(); return; }
  const idx=fadoTriggers.findIndex(x=>x.name===editingTriggerName);
  if(idx>=0) fadoTriggers.splice(idx,1);
  if(sqlDb){ sqlDb.run("DELETE FROM triggers WHERE name=?",[editingTriggerName]); persistDb(); }
  document.getElementById('trigger-editor').style.display='none';
  renderTriggers();
  appendOutput('Trigger deleted: '+editingTriggerName+'\n','system');
}

// =============================================================================
// PANEL NAVIGATION
// =============================================================================
export function togglePanel(name){
  const panels=['rooms','aliases','triggers','campaign'];   // the swipe cycle
  const all=[...panels,'settings','inventory'];
  const idx=panels.indexOf(name);
  if(idx>=0) swipePanelState=idx;   // settings/inventory are outside the cycle
  // Hide every panel, not just the swipeable ones -- inventory was absent from
  // this list, so opening another panel left it showing on top of the new one.
  for(const p of all){ const el=document.getElementById('panel-'+p); if(el) el.classList.remove('show'); }
  document.getElementById('panel-'+name).classList.add('show');
  if(name==='rooms') renderRooms();
  if(name==='aliases') renderAliases();
  if(name==='triggers') renderTriggers();
  if(name==='campaign') renderCampaign();
  if(name==='settings'){
    document.getElementById('set-buffer').value=maxLines;
    document.getElementById('db-info').textContent=sqlDb?'Ready':'Not loaded';
  }
}
export function hidePanel(name){ document.getElementById('panel-'+name).classList.remove('show'); }

export function saveBufferSetting(){
  const val=parseInt(document.getElementById('set-buffer').value)||200;
  document.getElementById('set-buffer').value=setMaxLines(val);
  const msg=document.getElementById('set-buffer-msg');
  msg.style.display='block';
  setTimeout(()=>msg.style.display='none',2000);
}

export function importFile(input){
  const file=input.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=async function(e){
    const data=new Uint8Array(e.target.result);
    try{
      await replaceDb(data);
      await persistDbNow();
      appendOutput('[Import] Database loaded ('+data.length+' bytes)\n','system');
      renderRooms();
    }catch(err){ appendOutput('[Import] Error: '+err+'\n','error'); }
  };
  reader.readAsArrayBuffer(file);
}

// Swipe disabled - panels are toggled via buttons only
export let sx=0, sy=0, swipeActive=false;
/*
document.getElementById('output').addEventListener('touchstart',e=>{ sx=e.touches[0].clientX; sy=e.touches[0].clientY; swipeActive=true; },{passive:true});
document.getElementById('output').addEventListener('touchend',e=>{
  if(!swipeActive) return;
  swipeActive=false;
  const ex=e.changedTouches[0].clientX, ey=e.changedTouches[0].clientY;
  const dx=ex-sx, dy=ey-sy;
  if(Math.abs(dx)<80 || Math.abs(dy)>60) return;
  const panels=['rooms','aliases','triggers','campaign'];
  if(dx>80) swipePanelState=(swipePanelState+1)%4;
  else if(dx<-80) swipePanelState=(swipePanelState+3)%4;
  togglePanel(panels[swipePanelState]);
},{passive:true});
*/

// Text shrink helper for room labels
export function abbrevRoomName(name){
  if(!name) return '?';
  const clean=stripAnsi(name).trim();
  if(!clean) return '?';
  const words=clean.split(/\s+/).filter(w=>w.length>0);
  if(words.length===1) return words[0].substring(0,2).toUpperCase();
  return (words[0][0]+words[words.length-1][0]).toUpperCase();
}

export function fitText(ctx, text, maxWidth, baseFontSize){
  ctx.font=baseFontSize+'px sans-serif';
  let w=ctx.measureText(text).width;
  if(w<=maxWidth) return;
  // Binary search smallest readable font
  let lo=6, hi=baseFontSize;
  while(hi-lo>0.5){
    const mid=(hi+lo)/2;
    ctx.font=mid+'px sans-serif';
    if(ctx.measureText(text).width<=maxWidth) lo=mid; else hi=mid;
  }
  ctx.font=lo+'px sans-serif';
}
