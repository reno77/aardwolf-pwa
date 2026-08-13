// net.js -- extracted from index.html

import { exportDb, importDb } from './db.js';
import { noticeVitalsText, processGMCP } from './gmcp.js';
import { showFullMap } from './map.js';
import { doNavTo, doRunto, navDiag, onMudText, walkToCoords } from './nav.js';
import { doCpCheck, doCpInfo, doHuntTrick, doQuickWhere, parseHuntOutput, parseWhereOutput,
         parseRuntoOutput, parseAutoHuntOutput, parseNotHereOutput, parseFollowMoveOutput,
         parseIdentifyOutput, parseWhereOrdOutput, parseKeyFetchOutput, parseKeyMobOutput,
         parseEntryItemOutput, parseRecallOutput,
         huntTo, stopAutoHunt,
         setXcpMode, setAutoRun, requestCampaign, setQuestmasterRoom, questmasterRoom,
         sndState, xcpByIndex, xcpNext, DEFAULT_RECALL } from './snd.js';
import { harvestAreaKeywords, parseAreasOutput } from './areas.js';
import { dinvCommand, parseInvData, parseInvDetails, dinvWatchText } from './dinv.js';
import { commandMap } from './state.js';
import { doXq, parseQuestRoomOutput, questInfo } from './quest.js';
import { leavePlane, stopLeavingPlane } from './plane.js';
import { parseKeyringOutput, showKeyring } from './keyring.js';
import { parseScanOutput } from './scan.js';
import { openTransport } from './transport.js';
import { setSyncBase, setSyncToken, syncBase, syncMap, syncOnLogin, syncReset,
         syncStatus } from './sync.js';
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
  if(seq){ sendCmdSequence(seq); return; }
  // Not an alias itself, but its argument might be: `wear wpn` -> `wear poly`.
  const expanded=expandAlias(text);
  if(expanded!==text && expanded.includes(';')){ sendCmdSequence(expanded); return; }
  sendCmdRaw(expanded);
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
  // Being in the world also means no login is outstanding, whatever route got us
  // here. `loginPending` was cleared in exactly one place -- closeLogin -- so a
  // dialog opened and then satisfied by the AUTO-login left the flag set, and
  // every command afterwards answered "[Login required]" while the character stood
  // in the game. Nothing recovered from that but a page reload.
  loginPending=false;
  try{ document.getElementById('login-overlay').classList.remove('show'); }catch(e){}
  setTimeout(requestGmcpState, 500);
  // Being in the world is also the moment to merge maps with the other clients:
  // the phone should start the session holding what the PC learned in the last
  // one, without anyone having to remember to press anything.
  syncOnLogin();
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

/**
 * Substitute an alias used as an ARGUMENT rather than as a whole command.
 *
 * `wpn` is an alias for `poly`, so `wear wpn` has to become `wear poly` -- the
 * MUD has never heard of "wpn". Expansion only ever matched a whole command, so
 * the recall sequence's `wear wpn` and `wear wpn 2` went to the game verbatim and
 * did nothing, which is why recall left the character unarmed.
 *
 * Deliberately narrow: only the argument, and only when the alias expands to a
 * SINGLE bare token. `heal` expands to a string of casts, and splicing that into
 * someone's `get heal` would be a surprise rather than a convenience.
 */
function expandArgAlias(cmd){
  const m = String(cmd).trim().match(/^(\S+)\s+(\S+)$/);
  if(!m) return cmd;
  const exp = commandMap[m[2].toLowerCase()];
  if(!exp) return cmd;
  const one = String(exp).trim();
  if(!one || /[;\s]/.test(one)) return cmd;    // not a single bare token
  return m[1] + ' ' + one;
}

export function expandAlias(cmd, depth, visited){
  if(depth===undefined) depth=0;
  if(visited===undefined) visited=new Set();
  if(depth>10) return cmd; // safety: max 10 levels deep
  const lower=cmd.trim().toLowerCase();
  if(visited.has(lower)) return cmd; // cycle detected
  const seq=commandMap[lower];
  if(!seq) return expandArgAlias(cmd);   // not an alias itself; its argument may be
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

/**
 * A bare Enter, exactly as a terminal client sends it.
 *
 * Aardwolf needs this for its pager ("[ Paging : (Enter), (T)op, (Q)uit ... ]")
 * and to redraw a prompt. It is not `sendCmd('')`, which would echo a stray "> ".
 */
export function sendBlankLine(){
  if(!ws||!connected){appendOutput('[Offline]\n','error');return;}
  if(loginPending){appendOutput('[Login required]\n','error');return;}
  ws.send(JSON.stringify({cmd:''}));
}

// =============================================================================
// /help
// =============================================================================
// Every client command, with what it is for. This table is the documentation, and
// tools/check_wiring.mjs compares it against the `cmd==='...'` tests in submitCmd
// in both directions -- so a command cannot be added without being documented, and
// help cannot describe one that no longer exists. Stale help is worse than none:
// it sends the player looking for a command that was renamed three commits ago.
//
// `cmds` lists every spelling the dispatcher accepts; the first is the one shown.
const HELP = [
  ['Getting about', [
    { cmds: ['runto', 'goto'], args: '<room name>', what: 'walk to a room by name, using the map' },
    { cmds: ['navto'], args: '[uid|room name]', what: 'walk to a room by its game number (exact) or by name; no argument prints the number of the room you are in, which is how you note one for later' },
    { cmds: ['navcoord'], args: '<x>,<y>', what: 'steer to a coordinate -- for continents and other areas the map does not cover, where every room reports its own position' },
    { cmds: ['navdiag'], args: '[room name]', what: 'why can it not path there: client build, this room and its edges, what it has been identified as, and the route to the named room' },
    { cmds: ['map'], args: '', what: 'the full-screen map' },
    { cmds: ['rooms'], args: '', what: 'the rooms panel; tap one to walk there' },
    { cmds: ['areas'], args: '', what: "ask the game for its real runto keyword list -- they are arbitrary ('kobaloi', 'tilule') and cannot be guessed from an area name" },
    { cmds: ['ah'], args: '<mob>', what: "autohunt: follow the server's own hunt one step at a time. The way to cross an area the map cannot express" },
  ]],
  ['Campaigns', [
    { cmds: ['xcp'], args: '<n|name>', what: 'go and kill campaign target n, counting only the ones still alive; a name works too and does not shift. /xcp 0 stops everything' },
    { cmds: ['cpcheck', 'ccheck'], args: '', what: 'read cp check and rebuild the target list' },
    { cmds: ['cpinfo', 'cinfo'], args: '', what: 'read cp info' },
    { cmds: ['campaign'], args: '', what: 'the campaign panel' },
    { cmds: ['keyring'], args: '', what: 'list the keys on your keyring -- the game checks it when unlocking, so a key here means no errand' },
    { cmds: ['cpnew'], args: '[auto]', what: 'walk to a quest master, take a campaign, and with "auto" start working through it' },
    { cmds: ['questmaster'], args: '[room]', what: 'where /cpnew goes to ask for a campaign' },
    { cmds: ['xcpauto'], args: '[off]', what: 'work through the whole campaign unattended -- rests when hurt, stops after 3 failures in a row (Aardwolf calls this botting: help policies7)' },
    { cmds: ['xcpstop'], args: '', what: 'stop the unattended campaign run' },
    { cmds: ['xcpmode'], args: '<ch|qw>', what: 'how a target is located: campaign-hunt or where' },
    { cmds: ['ht'], args: '[mob]', what: 'the hunt trick -- the copy that CANNOT be hunted is the campaign one' },
    { cmds: ['qw'], args: '[mob]', what: 'quick where' },
    { cmds: ['crr'], args: '', what: 'request a campaign (needs a questmaster)' },
  ]],
  ['Quests', [
    { cmds: ['xq'], args: '', what: 'go and kill the current quest target' },
    { cmds: ['leaveplane','lp'], args: '[rooms]', what: 'get out of a plane: walk back to the room the pool dropped you in and use the amulet' },
    { cmds: ['stopplane'], args: '', what: 'stop a /leaveplane probe' },
    { cmds: ['quest', 'qinfo'], args: '', what: 'the quest target, and whether its room is in the map' },
  ]],
  ['Map sharing', [
    { cmds: ['sync'], args: '', what: 'merge the learned map with the other clients through the relay' },
    { cmds: ['syncstatus'], args: '', what: 'what the relay holds, and where this client has got to' },
    { cmds: ['syncreset'], args: '', what: 'forget the watermarks; the next sync exchanges everything' },
    { cmds: ['syncurl'], args: '[url|default]', what: 'where the relay is (the Android app needs this -- it has no relay of its own)' },
    { cmds: ['synctoken'], args: '<value|off>', what: 'shared secret, if the relay is set up to require one' },
  ]],
  ['Kit and settings', [
    { cmds: ['dinv'], args: '[args]', what: 'the inventory tool' },
    { cmds: ['aliases'], args: '', what: 'the aliases panel' },
    { cmds: ['triggers'], args: '', what: 'the triggers panel' },
    { cmds: ['settings'], args: '', what: 'the settings panel' },
    { cmds: ['recallseq'], args: '[sequence]', what: 'show or set the recall sequence -- the commands run before a runto' },
    { cmds: ['export'], args: '', what: 'save the whole database to a file' },
    { cmds: ['import'], args: '', what: 'load a database from a file' },
  ]],
  ['Housekeeping', [
    { cmds: ['help', 'commands', '?'], args: '', what: 'this list' },
    { cmds: ['clear'], args: '', what: 'clear the output' },
    { cmds: ['buffer'], args: '<lines>', what: 'how much scrollback to keep' },
    { cmds: ['lag'], args: '[rounds]', what: 'measure the round trip, split into transport and MUD, so it is clear which is slow' },
  ]],
];

/** Every command spelling the help table documents. Read by check_wiring.mjs. */
export function helpCommands(){
  const out = [];
  for(const [, items] of HELP) for(const it of items) out.push(...it.cmds);
  return out;
}

function showHelp(){
  appendOutput('\nAardClient commands -- everything below is typed with a leading /\n', 'system');
  for(const [group, items] of HELP){
    appendOutput('\n  ' + group + '\n', 'quest');
    for(const it of items){
      const name = '/' + it.cmds[0] + (it.args ? ' ' + it.args : '');
      const also = it.cmds.length > 1 ? '  (also /' + it.cmds.slice(1).join(', /') + ')' : '';
      // Wrap the description under a fixed gutter so the list stays readable on a
      // phone, which is where it is most likely to be needed.
      const gutter = 26;
      const head = name.length < gutter ? name.padEnd(gutter) : name + '\n' + ' '.repeat(gutter);
      const words = (it.what + also).split(' ');
      let line = '', body = [];
      for(const w of words){
        if((line + ' ' + w).trim().length > 52){ body.push(line.trim()); line = w; }
        else line += ' ' + w;
      }
      if(line.trim()) body.push(line.trim());
      appendOutput('    ' + head + body[0] + '\n', 'system');
      for(const extra of body.slice(1)) appendOutput('    ' + ' '.repeat(gutter) + extra + '\n', 'system');
    }
  }
  appendOutput('\n', 'system');
}

export function submitCmd(){
  const el=document.getElementById('cmd-input');
  const text=el.value.trim();
  // Keep the caret in the box so the on-screen keyboard stays up -- paging
  // through a long help file means pressing this many times in a row.
  try { el.focus(); } catch(e){ /* not focusable yet */ }
  // An empty submit used to return here and do nothing at all, so the send
  // button was dead whenever the box was empty and there was no way to page
  // from a phone. Send the newline the MUD is waiting for instead.
  if(!text){ sendBlankLine(); return; }
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
    if(cmd==='help' || cmd==='commands' || cmd==='?'){ showHelp(); return; }
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
    if(cmd==='keyring'){ showKeyring(); return; }
    if(cmd==='cpnew'){ requestCampaign(/^auto$/i.test(parts[1]||'')); return; }
    if(cmd==='questmaster'){
      const n=parts.slice(1).join(' ').trim();
      if(n){ setQuestmasterRoom(n); appendOutput('[S&D] quest master room set: '+n+'\n','system'); }
      else appendOutput('[S&D] quest master room is '+questmasterRoom()+'\n','system');
      return;
    }
    if(cmd==='xcpauto'){ setAutoRun(!/^(off|stop|0|no)$/i.test(parts[1]||'')); return; }
    if(cmd==='xcpstop'){ setAutoRun(false); return; }
    if(cmd==='areas'){ harvestAreaKeywords(); return; }
    if(cmd==='navdiag'){ navDiag(parts.slice(1).join(' ').trim()); return; }
    // The whole argument, not parts[1]: a room name has spaces in it, and
    // `/navto Inside the Kitchen` used to search for a room called "Inside".
    if(cmd==='navto'){ doNavTo(parts.slice(1).join(' ')); return; }
    if(cmd==='navcoord'){
      const m=parts.slice(1).join(' ').match(/(-?\d+)\s*[, ]\s*(-?\d+)/);
      if(!m){ appendOutput('Usage: /navcoord <x>,<y>\n','system'); return; }
      walkToCoords(parseInt(m[1]), parseInt(m[2]));
      return;
    }
    if(cmd==='lag'){ measureLag(parseInt(parts[1])||5); return; }
    if(cmd==='ah'){ huntTo(parts.slice(1).join(' ')); return; }
    if(cmd==='goto'){ doRunto(parts.slice(1).join(' ')); return; }
    if(cmd==='dinv'){ dinvCommand(parts.slice(1).join(' ')); return; }
    if(cmd==='xcpmode'){ setXcpMode(parts[1]||''); return; }
    if(cmd==='ht'){ doHuntTrick(parts.slice(1).join(' ').trim()); return; }
    if(cmd==='qw'){ doQuickWhere(parts.slice(1).join(' ').trim()); return; }
    if(cmd==='xq'){ doXq(); return; }
    if(cmd==='leaveplane' || cmd==='lp'){ leavePlane(parts[1]); return; }
    if(cmd==='stopplane'){ stopLeavingPlane('asked to stop'); return; }
    if(cmd==='quest' || cmd==='qinfo'){ questInfo(); return; }
    if(cmd==='sync'){ syncMap({}); return; }
    if(cmd==='syncstatus'){ syncStatus(); return; }
    if(cmd==='syncreset'){ syncReset(); return; }
    if(cmd==='syncurl'){
      const url=parts.slice(1).join(' ').trim();
      if(url){ setSyncBase(url === 'default' ? '' : url); appendOutput('[sync] relay set to '+syncBase()+'\n','system'); }
      else { appendOutput('[sync] relay is '+syncBase()+' (/syncurl <url> to change, /syncurl default to reset)\n','system'); }
      return;
    }
    if(cmd==='synctoken'){
      const tok=parts.slice(1).join(' ').trim();
      setSyncToken(tok === 'off' ? '' : tok);
      appendOutput('[sync] token '+(tok && tok!=='off' ? 'set' : 'cleared')+'\n','system');
      return;
    }
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
        appendOutput('[S&D] current recall sequence: '+(sndState.recallSequence||DEFAULT_RECALL)+'\n','system');
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
    // A WebSocket to the relay in a browser; the native TCP bridge in the
    // Android app. Same JSON protocol either way -- see transport.js.
    ws=openTransport();
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
      noticeVitalsText(msg.text);   // the prompt is the only vitals feed always present
      noticeInGame(msg.text);       // first prompt => ask the relay to re-request GMCP state
      onMudText(msg.text);          // let an in-flight walk notice "no exit that way" etc.
      parseInvData(msg.text);          // eqdata/invdata blocks
      parseInvDetails(msg.text);       // invdetails: wear slot + item score
      dinvWatchText(msg.text);         // tie a get/wear refusal back to the swap
      parseAreasOutput(msg.text);      // learning the area keyword list
      parseRuntoOutput(msg.text);      // notice a refused `rt`
      parseAutoHuntOutput(msg.text);   // server-driven maze navigation
      parseNotHereOutput(msg.text);    // right room name, wrong room: sweep the twins
      parseFollowMoveOutput(msg.text); // a shut door on a hunt trail
      parseIdentifyOutput(msg.text);   // which copy cannot be hunted
      parseWhereOrdOutput(msg.text);   // and where that copy is
      parseKeyFetchOutput(msg.text);   // did the key actually come out of the box
      parseKeyMobOutput(msg.text);     // ...or off the mob that was carrying it
      parseQuestRoomOutput(msg.text);  // which copy here wears the [Quest] tag
      parseEntryItemOutput(msg.text);  // readying a held portal such as the amulet
      parseRecallOutput(msg.text);     // did a step of the recall sequence get refused
      parseScanOutput(msg.text);       // what is standing in the neighbouring rooms
      parseKeyringOutput(msg.text);    // which keys we already carry
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
