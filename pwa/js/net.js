// net.js -- extracted from index.html

import { exportDb, importDb } from './db.js';
import { processGMCP } from './gmcp.js';
import { showFullMap } from './map.js';
import { doRunto, onMudText } from './nav.js';
import { doCpCheck, doCpInfo, doHuntTrick, doQuickWhere, parseHuntOutput, parseWhereOutput,
         parseRuntoOutput, parseAutoHuntOutput, huntTo, stopAutoHunt, setXcpMode, sndState, xcpByIndex, xcpNext } from './snd.js';
import { harvestAreaKeywords, parseAreasOutput } from './areas.js';
import { dinvCommand, parseInvData, parseInvDetails } from './dinv.js';
import { WS_URL, commandMap } from './state.js';
import { appendOutput, checkQuest, clearOutput, maxLines, processTriggers, setMaxLines, togglePanel, triggered } from './ui.js';
// --- state owned by this module ---
export let ws=null;
export let connected=false;
export let loginPending=false;
export let cmdHistory=[];
export let historyIdx=-1;

// =============================================================================
// COMMANDS & ALIASES
// =============================================================================
export function sendCmd(text){
  if(!ws||!connected){appendOutput('[Offline]\n','error');return;}
  if(loginPending){appendOutput('[Login required]\n','error');return;}
  if(text.includes(';')){
    sendCmdSequence(text);
    return;
  }
  const seq=commandMap[text];
  if(seq){ sendCmdSequence(seq); }
  else { sendCmdRaw(text); }
}
export function sendCmdRaw(text){
  if(!ws||!connected){appendOutput('[Offline]\n','error');return;}
  ws.send(JSON.stringify({cmd:text})); appendOutput('> '+text+'\n','echo');
}

// -----------------------------------------------------------------------------
// Movement
// -----------------------------------------------------------------------------
// There used to be a 500ms `lastMoveTime` gate here that dropped any movement
// arriving sooner -- silently, with no send and no echo. One global counter was
// shared by both joysticks, the map walker, /runto and the S&D automation, so
// they cancelled each other: tap-to-walk paced its steps 400ms apart and lost
// roughly every second one, and /runto emitted a whole path in one tick and
// landed only the first step while printing the full path as if it had worked.
//
// Pacing now belongs to the walker (nav.js), which sends one step and waits for
// the GMCP room.info that confirms it. Manual moves go out immediately.

// Set by nav.js while a path walk is in flight, so a manual move can cancel it
// instead of racing it. Kept as a registered callback to avoid an import cycle.
let walkCanceller = null;
export function setWalkCanceller(fn){ walkCanceller = fn; }

// The relay's GMCP handshake requests full state when the TCP session opens,
// which is before the player logs in -- so a session that logs in afterwards
// never receives a room.info and the client has no idea where it is until the
// first move. Ask again once we are actually in the game.
let gmcpRequested=false;
export function requestGmcpState(){
  if(!ws||!connected) return;
  ws.send(JSON.stringify({action:'gmcp_request'}));
}

/** Called from the output stream: the game prompt means we are in the world. */
export function noticeInGame(text){
  if(gmcpRequested || !text) return;
  // Aardwolf's prompt carries vitals, e.g. "[2651/2651hp 1976/1976mn ...]".
  if(!/\d+\/\d+hp/.test(text)) return;
  gmcpRequested=true;
  setTimeout(requestGmcpState, 500);
}

// -----------------------------------------------------------------------------
// Lag measurement
// -----------------------------------------------------------------------------
// Guessing at lag from a desktop is hopeless when the symptom only shows on a
// phone over a tunnel. `/lag` splits the round trip into its parts so it is
// obvious which one is at fault:
//   transport = browser -> relay -> browser  (does not touch the MUD)
//   mud       = the same trip plus the MUD's own reply
let pingResolve = null;
export function notePong(){ if(pingResolve){ const f=pingResolve; pingResolve=null; f(); } }

export async function measureLag(rounds){
  if(!ws || !connected){ appendOutput('[lag] not connected\n','error'); return; }
  rounds = rounds || 5;
  const t = [];
  for(let i=0;i<rounds;i++){
    const t0 = performance.now();
    const done = new Promise(r => { pingResolve = r; });
    ws.send(JSON.stringify({action:'ping'}));
    const timed = await Promise.race([
      done.then(()=>true),
      new Promise(r => setTimeout(()=>r(false), 8000)),
    ]);
    if(timed) t.push(performance.now()-t0);
    await new Promise(r => setTimeout(r, 250));
  }
  if(!t.length){ appendOutput('[lag] no pong came back at all\n','error'); return; }
  t.sort((a,b)=>a-b);
  const med = t[Math.floor(t.length/2)];
  appendOutput(`[lag] transport round trip: min ${t[0].toFixed(0)}ms  median ${med.toFixed(0)}ms  max ${t[t.length-1].toFixed(0)}ms  (${t.length}/${rounds} replied)\n`,'system');
  appendOutput(`[lag] ${med > 250 ? 'the link to the relay is the bottleneck -- try the LAN address instead of the tunnel' : 'the link is fine; any remaining delay is the MUD itself or the client'}\n`,'system');
}

/** Single entry point for one movement step, manual or automated. */
export function queueMove(dir, opts){
  const fromWalker = !!(opts && opts.fromWalker);
  if(!ws||!connected){appendOutput('[Offline]\n','error');return false;}
  if(loginPending){appendOutput('[Login required]\n','error');return false;}
  if(!fromWalker && walkCanceller){
    // The player grabbed the wheel; stop the automated walk rather than
    // interleaving two sources of movement into the same session.
    const cancel = walkCanceller;
    walkCanceller = null;
    try { cancel('manual move'); } catch(e){ console.error(e); }
    appendOutput('[nav] walk cancelled by manual move\n','system');
  }
  ws.send(JSON.stringify({cmd:dir}));
  appendOutput('> '+dir+'\n','echo');
  return true;
}

export function expandAlias(cmd, depth, visited){
  if(depth===undefined) depth=0;
  if(visited===undefined) visited=new Set();
  if(depth>10) return cmd; // safety: max 10 levels deep
  const lower=cmd.trim().toLowerCase();
  if(visited.has(lower)) return cmd; // cycle detected
  const seq=commandMap[lower];
  if(!seq) return cmd; // not an alias, return as-is
  visited.add(lower);
  const parts=seq.split(';');
  const expanded=[];
  for(const p of parts){
    const c=p.trim();
    if(!c) continue;
    const sub=expandAlias(c, depth+1, visited);
    expanded.push(sub);
  }
  return expanded.join(';');
}

export function sendCmdSequence(seq){
  const flat=expandAlias(seq);
  const cmds=flat.split(';');
  let delay=0;
  for(const cmd of cmds){
    const c=cmd.trim();
    if(!c) continue;
    setTimeout(()=>{ if(ws&&connected){ ws.send(JSON.stringify({cmd:c})); appendOutput('> '+c+'\n','echo'); } }, delay);
    delay+=300;
  }
  appendOutput('[Alias] '+cmds[0]+'\n','system');
}

export function submitCmd(){
  const el=document.getElementById('cmd-input');
  const text=el.value.trim();
  if(!text) return;
  // Add to history, keep last 10
  if(cmdHistory.length===0 || cmdHistory[cmdHistory.length-1]!==text){
    cmdHistory.push(text);
    if(cmdHistory.length>10) cmdHistory.shift();
  }
  historyIdx=cmdHistory.length;
  el.value=''; // clear input after sending
  // Process command
  if(text.startsWith('/')){
    const parts=text.slice(1).split(' ');
    const cmd=parts[0].toLowerCase();
    if(cmd==='runto'){ doRunto(parts.slice(1).join(' ')); return; }
    if(cmd==='aliases'){ togglePanel('aliases'); return; }
    if(cmd==='triggers'){ togglePanel('triggers'); return; }
    if(cmd==='rooms'){ togglePanel('rooms'); return; }
    if(cmd==='map'){ showFullMap(); return; }
    if(cmd==='settings'){ togglePanel('settings'); return; }
    if(cmd==='export'){ exportDb(); return; }
    if(cmd==='import'){ importDb(); return; }
    if(cmd==='campaign'){ togglePanel('campaign'); return; }
    if(cmd==='cpinfo' || cmd==='cinfo'){ doCpInfo(); return; }
    if(cmd==='cpcheck' || cmd==='ccheck'){ doCpCheck(); return; }
    if(cmd==='xcp'){
      const args=parts.slice(1).filter(x=>x.trim());
      if(args.length){
        const index=args[0];
        const overrideKw=args.slice(1).join(' ')||'';
        xcpByIndex(index, overrideKw);
      } else { xcpNext(); }
      return;
    }
    if(cmd==='areas'){ harvestAreaKeywords(); return; }
    if(cmd==='lag'){ measureLag(parseInt(parts[1])||5); return; }
    if(cmd==='ah'){ huntTo(parts.slice(1).join(' ')); return; }
    if(cmd==='goto'){ doRunto(parts.slice(1).join(' ')); return; }
    if(cmd==='dinv'){ dinvCommand(parts.slice(1).join(' ')); return; }
    if(cmd==='xcpmode'){ setXcpMode(parts[1]||''); return; }
    if(cmd==='ht'){ doHuntTrick(parts.slice(1).join(' ').trim()); return; }
    if(cmd==='qw'){ doQuickWhere(parts.slice(1).join(' ').trim()); return; }
    if(cmd==='crr'){ sendCmd('crr'); return; }
    if(cmd==='clear'){ clearOutput(); return; }
    if(cmd==='buffer'){ setMaxLines(parseInt(parts[1])||200); appendOutput('Buffer set to '+maxLines+'\n','system'); return; }
    if(cmd==='recallseq'){
      const seq=parts.slice(1).join(' ').trim();
      if(seq){
        sndState.recallSequence=seq;
        localStorage.setItem('recall_sequence', seq);
        appendOutput('[S&D] recall sequence set: '+seq+'\n','system');
      } else {
        appendOutput('[S&D] current recall sequence: '+(sndState.recallSequence||'wear garbage;enter;rem garbage;wear wpn;wear wpn 2')+'\n','system');
      }
      return;
    }
    appendOutput('Unknown: '+text+'\n','error'); return;
  }
  const lower=text.toLowerCase();
  if(lower==='dinv' || lower.startsWith('dinv ')){ dinvCommand(text.slice(4)); return; }
  if(lower==='campaign'){ togglePanel('campaign'); return; }
  const seq=commandMap[lower];
  if(seq){ sendCmdSequence(seq); }
  else { sendCmd(text); }
}

export function cmdHistoryUp(){
  const el=document.getElementById('cmd-input');
  if(cmdHistory.length===0) return;
  if(historyIdx>0) historyIdx--;
  el.value=cmdHistory[historyIdx];
}

export function cmdHistoryDown(){
  const el=document.getElementById('cmd-input');
  if(cmdHistory.length===0) return;
  if(historyIdx<cmdHistory.length-1) historyIdx++;
  el.value=cmdHistory[historyIdx];
}

// =============================================================================
// LOGIN
// =============================================================================
export function showLogin(){loginPending=true;loadSavedLogin();var n=document.getElementById('login-name');if(!n.value.trim())n.value=n.placeholder||'';document.getElementById('login-overlay').classList.add('show');}
export function closeLogin(){loginPending=false;document.getElementById('login-overlay').classList.remove('show');}

export function doLogin(){
  appendOutput('[Login] Preparing to send...\n','system');
  const name=document.getElementById('login-name').value.trim();
  const pass=document.getElementById('login-pass').value.trim();
  if(!name){ appendOutput('Enter character name first.\n','error'); return; }
  appendOutput('[Login] Name: '+name+'\n','system');
  if(document.getElementById('save-login').checked){
    try{localStorage.setItem('aard_name',name);if(pass)localStorage.setItem('aard_pass',btoa(pass));}catch(e){}
  }
  // Prevent auto-login triggers from firing after manual login
  triggered.add('login-name');
  triggered.add('login-pass');
  if(ws&&connected){
    appendOutput('[Login] Sending name to MUD...\n','system');
    ws.send(JSON.stringify({cmd:name}));
    appendOutput('> '+name+'\n','echo');
  } else { appendOutput('Not connected.\n','error'); return; }
  if(pass&&ws&&connected){
    appendOutput('[Login] Will send password in 2.0s...\n','system');
    setTimeout(()=>{
      appendOutput('[Login] Sending password...\n','system');
      ws.send(JSON.stringify({cmd:pass}));
      appendOutput('> ***\n','echo');
    },2000);
  }
  appendOutput('[Login] Closing popup\n','system');
  closeLogin();
}

export function loadSavedLogin(){
  try{
    const name=localStorage.getItem('aard_name'),pass=localStorage.getItem('aard_pass');
    if(name) document.getElementById('login-name').value=name;
    if(pass) try{document.getElementById('login-pass').value=atob(pass);}catch(e){}
  }catch(e){}
}

// =============================================================================
// WEBSOCKET
// =============================================================================
export async function doConnect(force){
  if(ws){ ws.close(); ws=null; }
  triggered.clear();
  if(offlineShowTimer){ clearTimeout(offlineShowTimer); offlineShowTimer=null; }
  appendOutput('Connecting...\n','system');
  try{
    ws=new WebSocket(WS_URL);
    ws.onopen=()=>{
      connected=true;
      gmcpRequested=false;
      document.getElementById('connect-btn').textContent='Disconnect';
      document.getElementById('connect-btn').className='disconnect';
      document.getElementById('offline-overlay').classList.add('hidden');
      if(offlineShowTimer){ clearTimeout(offlineShowTimer); offlineShowTimer=null; }
      appendOutput('Connected to relay.\n','system');
      ws.send(JSON.stringify({action:'connect'}));
    };
    ws.onmessage=(e)=>{
      try{
        const msg=JSON.parse(e.data);
        handleMessage(msg);
      }catch(err){ console.error('WS parse error', err); }
    };
    ws.onclose=()=>{ connected=false; ws=null; appendOutput('Disconnected.\n','system'); doReconnect(); };
    ws.onerror=(e)=>{ appendOutput('Connection error.\n','error'); };
  }catch(e){ appendOutput('Failed to connect.\n','error'); }
}

export function handleMessage(msg){
  switch(msg.type){
    case 'text':
      appendOutput(msg.text,'');
      noticeInGame(msg.text);       // first prompt => ask the relay to re-request GMCP state
      onMudText(msg.text);          // let an in-flight walk notice "no exit that way" etc.
      parseInvData(msg.text);          // eqdata/invdata blocks
      parseInvDetails(msg.text);       // invdetails: wear slot + item score
      parseAreasOutput(msg.text);      // learning the area keyword list
      parseRuntoOutput(msg.text);      // notice a refused `rt`
      parseAutoHuntOutput(msg.text);   // server-driven maze navigation
      processTriggers(msg.text); parseWhereOutput(msg.text); parseHuntOutput(msg.text); checkQuest(msg.text);
      break;
    case 'echo': appendOutput(msg.text,'echo'); break;
    case 'error': appendOutput(msg.text,'error'); break;
    case 'system': appendOutput(msg.text,'system'); break;
    case 'quest': appendOutput(msg.text,'quest'); break;
    case 'gmcp': processGMCP(msg.key, msg.data); break;
    case 'pong': notePong(); break;
  }
}

export let reconnectDelay=1000, reconnectTimer=null, offlineShowTimer=null;
export function doReconnect(){
  document.getElementById('connect-btn').textContent='Connect';
  document.getElementById('connect-btn').className='connect';
  if(reconnectTimer) clearTimeout(reconnectTimer);
  if(offlineShowTimer) clearTimeout(offlineShowTimer);
  // Only show offline overlay if reconnect fails for 3 seconds
  offlineShowTimer=setTimeout(()=>{
    document.getElementById('offline-overlay').classList.remove('hidden');
  }, 3000);
  if(reconnectDelay>30000) reconnectDelay=30000;
  appendOutput('Reconnecting in '+Math.round(reconnectDelay/1000)+'s...\n','system');
  reconnectTimer=setTimeout(()=>{ reconnectDelay=Math.min(reconnectDelay*2,30000); doConnect(true); }, reconnectDelay);
}

// Ping/pong
setInterval(()=>{ if(ws&&connected) ws.send(JSON.stringify({action:'ping'})); },30000);

// Visibility reconnect
export let wasHidden=false;
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden && wasHidden && !connected){
    reconnectDelay=1000;
    if(reconnectTimer) clearTimeout(reconnectTimer);
    doConnect(true);
  }
  wasHidden=document.hidden;
});
