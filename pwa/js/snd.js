// snd.js -- extracted from index.html

import { findAreaAnywhere, gaardianDb, resolveRoomByNameAnywhere, sqlDb } from './db.js';
import { currentRoom, charState, charLevel, STATE_READY, STATE_FIGHTING } from './gmcp.js';
import { sendCmd, sendCmdRaw } from './net.js';
import { findPath, walkTo, cancelWalk, isWalking } from './nav.js';
import { lookupArea, runtoFailed, harvestAreaKeywords, parseAreasOutput } from './areas.js';
import { appendOutput, stripAnsi, togglePanel } from './ui.js';
// --- state owned by this module ---
export let campaignTargets=[]; // S&D target list, built from cp info + cp check
export let sndState={cpType:'none', cpLevel:0, xcpIndex:0, xcpMode:localStorage.getItem('xcp_mode')||'ch', recallSequence:localStorage.getItem('recall_sequence')||'wear garbage;enter;rem garbage;wear wpn;wear wpn 2'};
export let lastCpInfoRaw='';
export let lastCpCheckRaw='';
export let lastCampaignRaw='';

// =============================================================================
// SEARCH AND DESTROY CAMPAIGN HELPER (ported from Search_and_Destroy_v2.0.xml)
// =============================================================================
export function gmkw(s, areaName){
  // Use the entire mob name (without leading article) as a quoted keyword.
  // e.g. 'a large apple tree' -> '"large apple tree"'
  if(!s) return '';
  const trimmed=s.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'').trim();
  if(!trimmed) return '';
  // Quote it so Aardwolf treats it as a single phrase.
  return '"'+trimmed+'"';
}

export function huntTrickKw(s){
  // For numbered hunt, default to the same keyword as gmkw.
  return gmkw(s);
}

// Pathfinding and stepwise movement used to live here as two more copies of
// the same BFS (both loading the entire `exits` table on every step, both
// synthesising bogus reverse edges) plus a stepper that refused any custom exit.
// All of it now delegates to nav.js.

export function pickNearestRoom(rooms, fromUid){
  if(!rooms.length) return null;
  let best=null, bestLen=Infinity;
  for(const r of rooms){
    const path=findPath(fromUid, r.uid);
    if(path && path.length<bestLen){ bestLen=path.length; best=r; }
  }
  return best || rooms[0];
}

export function gotoRoomUid(toUid, onDone){
  if(!toUid) return;
  walkTo(toUid, onDone, (reason)=>{
    appendOutput('[S&D] could not reach the target room ('+reason+').\n','error');
  });
}

export function resolveAreaUid(areaName){
  if(!sqlDb || !areaName) return null;
  const res=sqlDb.exec("SELECT DISTINCT area FROM rooms WHERE area LIKE ? LIMIT 1", ['%'+areaName+'%']);
  if(res.length && res[0].values.length) return res[0].values[0][0];
  return null;
}

export function areaNameMatches(a, b){
  if(!a || !b) return false;
  const la=a.toLowerCase().replace(/[^a-z0-9]/g,'');
  const lb=b.toLowerCase().replace(/[^a-z0-9]/g,'');
  if(la===lb) return true;
  // 'hedge' should match 'hedgehogs' and vice versa when one is a prefix of the other.
  if(la.length>=4 && lb.startsWith(la)) return true;
  if(lb.length>=4 && la.startsWith(lb)) return true;
  return false;
}

export function resolveRoomByName(roomName, areaName){
  const rooms=resolveRoomsByName(roomName, areaName);
  return rooms.length?rooms[0]:null;
}

export function resolveRoomsByName(roomName, areaName){
  if(!sqlDb || !roomName) return [];
  let res;
  if(areaName){
    res=sqlDb.exec("SELECT uid, name, area FROM rooms WHERE name LIKE ? AND area LIKE ?", ['%'+roomName+'%', '%'+areaName+'%']);
  } else {
    res=sqlDb.exec("SELECT uid, name, area FROM rooms WHERE name LIKE ?", ['%'+roomName+'%']);
  }
  return (res.length && res[0].values)?res[0].values.map(r=>({uid:r[0], name:r[1], area:r[2]})):[];
}

export function runtoArea(areaName){
  // Aardwolf's own runto handles area-level travel; room-level navigation inside
  // an area goes through gotoRoomUid or the hunt fallback.
  const area=lookupArea(areaName);
  if(!area){
    appendOutput('[S&D] cannot derive runto keyword for '+areaName+'\n','error');
    return false;
  }
  if(area.nogo){
    appendOutput('[S&D] '+areaName+' cannot be reached with runto.\n','error');
    return false;
  }
  appendOutput('[S&D] runto '+area.key+(area.guessed?' (guessed)':'')+'\n','quest');
  sendCmd('rt '+area.key);
  return true;
}

// Legacy 'campaign' command output parser (kept for compatibility)
export function parseCampaignOutput(text){
  const clean=stripAnsi(text);
  if(!clean.includes('Campaign') && !clean.includes('Remaining') && !clean.includes('campaign') && !clean.includes('request')) return;
  lastCampaignRaw+=clean+'\n';
  const lines=clean.split('\n');
  let found=false;
  for(const line of lines){
    const m=line.match(/(\d+)\.\s+(.+?)\s+(?:in|of|near|at|around)\s+(.+?)\s*\((\d+)\/(\d+)\)/i);
    if(m){
      const idx=parseInt(m[1])-1;
      const areaName=resolveAreaUid(m[3].trim()) || m[3].trim();
      const room=resolveRoomByName(m[2].trim(), areaName);
      campaignTargets[idx]={mob:m[2].trim(), areaName:areaName, area:m[3].trim(), progress:parseInt(m[4]), total:parseInt(m[5]), completed:parseInt(m[4])>=parseInt(m[5]), is_dead:parseInt(m[4])>=parseInt(m[5]), type:room?'room':'area', roomUid:room?room.uid:null, roomName:room?room.name:null, kw:gmkw(m[2].trim(), areaName)};
      found=true;
    }
  }
  if(found) renderCampaign();
}

// cp info parser
export function parseCpInfoOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw).trim();
    if(!clean) continue;
    const levelMatch=clean.match(/Level\s+Taken[\s.]*:\s*\[\s*(\d{1,3})\s*\]/i);
    if(levelMatch){
      sndState.cpLevel=parseInt(levelMatch[1]);
      sndState._inCpInfo=true;
      sndState._cpInfoTmp=[];
      continue;
    }
    if(/targets\s+for\s+this\s+campaign\s+are/i.test(clean)){ sndState._inCpInfo=true; sndState._cpInfoTmp=[]; continue; }
    if(!sndState._inCpInfo) continue;
    const m=clean.match(/^\s*Find\s+and\s+kill\s+1\s+\*\s+(.+?)\s+\(([^)]+)\)\s*$/i);
    if(m){
      sndState._cpInfoTmp.push({mob:m[1].trim(), loc:m[2].trim()});
      continue;
    }
    sndState._inCpInfo=false;
    buildCpTargets(sndState._cpInfoTmp);
  }
}

// cp check parser
export function parseCpCheckOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw).trim();
    if(!clean) continue;
    const m=clean.match(/^\s*You\s+still\s+have\s+to\s+kill\s+\*\s+(.+?)\s+\((.+?)(\s*-\s*Dead)?\)\s*$/i);
    if(m){
      if(!sndState._inCpCheck){ sndState._inCpCheck=true; sndState._cpCheckTmp=[]; }
      const dead=!!m[3];
      const loc=m[2].trim();
      sndState._cpCheckTmp.push({mob:m[1].trim(), loc:loc, is_dead:dead});
      continue;
    }
    if(sndState._inCpCheck){
      sndState._inCpCheck=false;
      if(campaignTargets.length===0){
        buildCpTargetsFromCheck(sndState._cpCheckTmp);
      } else {
        mergeCpCheck(sndState._cpCheckTmp);
      }
      // Trigger pending xcp verification if any
      if(sndState.pendingCpCheckCallback){
        const idx=(sndState.xcpIndex||1)-1;
        const t=campaignTargets[idx];
        const cb=sndState.pendingCpCheckCallback;
        sndState.pendingCpCheckCallback=null;
        cb(!!(t&&t.is_dead));
      }
    }
  }
}

// cp status parser
export function parseCpStatusOutput(text){
  for(const raw of text.split(/\r?\n/)){
    const clean=stripAnsi(raw);
    if(/^\s*You\s+are\s+not\s+currently\s+on\s+a\s+campaign\s*\.?\s*$/i.test(clean) || /^\s*CONGRATULATIONS!\s+You\s+have\s+completed\s+your\s+campaign\s*\.?\s*$/i.test(clean) || /^\s*Campaign\s+cleared\s*\.?\s*$/i.test(clean)){
      sndState.cpType='none';
      campaignTargets=[];
      renderCampaign();
      return;
    }
    if(/^\s*You\s+have\s+.+\s+left\s+to\s+finish\s+this\s+campaign\s*\.?\s*$/i.test(clean)){ sndState.onCp=true; }
  }
}

export function buildCpTargets(infoList){
  // Determine area vs room type by majority
  let areaCount=0, roomCount=0;
  const tmp=[];
  for(const v of infoList){
    const areaUid=resolveAreaUid(v.loc);
    if(areaUid){ areaCount++; tmp.push({...v, type:'area', areaName:areaUid, areaUid:areaUid}); }
    else {
      const room=resolveRoomByName(v.loc);
      if(room){ roomCount++; tmp.push({...v, type:'room', roomUid:room.uid, roomName:room.name, areaName:room.area, areaUid:room.area}); }
      else { areaCount++; tmp.push({...v, type:'unknown', areaName:v.loc, areaUid:null}); }
    }
  }
  sndState.cpType=(areaCount>=roomCount)?'area':'room';
  campaignTargets=tmp.map((v,i)=>({
    mob:v.mob,
    areaName:v.areaName,
    area:v.areaName,
    areaUid:v.areaUid,
    roomUid:v.roomUid||null,
    roomName:v.roomName||null,
    type:v.type,
    progress:0, total:1, completed:false, is_dead:false,
    index:i+1,
    kw:gmkw(v.mob, v.areaName)
  }));
  appendOutput('[S&D] cp info parsed: '+campaignTargets.length+' targets, type='+sndState.cpType+'\n','quest');
  renderCampaign();
}

export function buildCpTargetsFromCheck(checkList){
  // Build campaign targets directly from cp check output (cp info not available/failed)
  let areaCount=0, roomCount=0;
  const tmp=[];
  for(const v of checkList){
    const areaUid=resolveAreaUid(v.loc);
    if(areaUid){ areaCount++; tmp.push({...v, type:'area', areaName:areaUid, areaUid:areaUid}); }
    else {
      const room=resolveRoomByName(v.loc);
      if(room){ roomCount++; tmp.push({...v, type:'room', roomUid:room.uid, roomName:room.name, areaName:room.area, areaUid:room.area}); }
      else { areaCount++; tmp.push({...v, type:'unknown', areaName:v.loc, areaUid:null}); }
    }
  }
  sndState.cpType=(areaCount>=roomCount)?'area':'room';
  campaignTargets=tmp.map((v,i)=>({
    mob:v.mob,
    areaName:v.areaName,
    area:v.areaName,
    areaUid:v.areaUid,
    roomUid:v.roomUid||null,
    roomName:v.roomName||null,
    type:v.type,
    progress:v.is_dead?1:0, total:1, completed:!!v.is_dead, is_dead:!!v.is_dead,
    index:i+1,
    kw:gmkw(v.mob, v.areaName)
  }));
  appendOutput('[S&D] cp check parsed: '+campaignTargets.length+' targets, type='+sndState.cpType+'\n','quest');
  renderCampaign();
}

export function mergeCpCheck(checkList){
  for(const c of checkList){
    const t=campaignTargets.find(x=>x.mob.toLowerCase()===c.mob.toLowerCase() || c.mob.toLowerCase().includes(x.mob.toLowerCase()) || x.mob.toLowerCase().includes(c.mob.toLowerCase()));
    if(t){
      t.is_dead=c.is_dead;
      t.completed=c.is_dead;
      if(t.is_dead) t.progress=t.total;
    }
  }
  appendOutput('[S&D] cp check merged: '+checkList.length+' entries\n','quest');
  renderCampaign();
}

export function xcpNext(){
  if(sndState.cpType==='none'){ appendOutput('[S&D] Not on a campaign.\n','error'); return; }
  for(const t of campaignTargets){
    if(t.is_dead) continue;
    xcpByIndex(t.index);
    return;
  }
  appendOutput('[S&D] No reachable live targets.\n','error');
}

export function xcpByIndex(index, overrideKw){
  const idx=parseInt(index);
  if(idx===0){ sndState.xcpIndex=0; sndState.shortMobName=''; sndState.pendingXcp=null; sndState.xcpAwaitingArea=null; appendOutput('[S&D] xcp target cleared.\n','system'); return; }
  const t=campaignTargets[idx-1];
  if(!t){ appendOutput('[S&D] Invalid xcp index: '+index+'\n','error'); return; }
  if(t.type==='unknown'){
    appendOutput('[S&D] Target #'+idx+' location unknown; will discover via where.\n','quest');
  }
  if(t.is_dead){ appendOutput('[S&D] Target #'+idx+' already dead.\n','system'); return; }
  sndState.xcpIndex=idx;
  sndState.shortMobName=t.kw;
  sndState.pendingXcp=null;
  sndState.xcpAwaitingArea=null;
  appendOutput('[S&D] xcp '+idx+': '+t.mob+' ('+t.type+' in '+t.areaName+')\n','quest');
  let htkw = overrideKw || t.htkwOverride || huntTrickKw(t.mob);
  let kw = gmkw(t.mob);
  const pending={...t, recallSent:false, located:false, roomQueue:[], roomIndex:0, whereInstances:null, huntTrickIndex:1, campaignInstance:null, htkw:htkw, kw:kw};
  sndState.pendingXcp=pending;
  xcpStep(pending);
}

export function xcpRecall(t, onComplete){
  // User's recall alias is an equipment sequence, not the simple 'rec' command.
  const recallSeq=(sndState.recallSequence||'wear garbage;enter;rem garbage;wear wpn;wear wpn 2').split(';');
  let delay=0;
  for(const cmd of recallSeq){
    const c=cmd.trim();
    if(!c) continue;
    setTimeout(()=>sendCmdRaw(c), delay);
    delay+=1000;
  }
  // Give Aardwolf time to finish the recall before runto.
  setTimeout(onComplete, delay+1500);
}

/**
 * Give up on one target and move to the next, rather than retrying forever.
 * Every dead end in the old code just nulled pendingXcp and stopped silently.
 */
export function xcpAbandonTarget(t, reason){
  if(sndState.xcpAwaitingTimer){ clearTimeout(sndState.xcpAwaitingTimer); sndState.xcpAwaitingTimer=null; }
  sndState.xcpAwaitingArea=null;
  sndState.xcpRuntoTarget=null;
  sndState.pendingXcp=null;
  sndState.xcpNav=null;
  if(isWalking()) cancelWalk(reason);
  if(t) t.skipped=reason || 'skipped';
  const remaining=campaignTargets.filter(x=>!x.is_dead && !x.skipped);
  // Deliberately does NOT chain into the next target on its own. Aardwolf's
  // 'help policies7' names "read campaign information to automatically go to
  // areas, find and kill mob" as botting, and an unattended target-to-target
  // loop is exactly that. Stop here and let the player choose to continue.
  if(remaining.length){
    appendOutput('[S&D] '+remaining.length+' target(s) left -- /xcp when you want the next one.\n','quest');
  } else {
    appendOutput('[S&D] no auto-navigable targets left.\n','quest');
  }
}

/** Watch MUD output for a failed `rt` so we do not wait out the full timeout. */
export function parseRuntoOutput(text){
  const t=sndState.xcpRuntoTarget;
  if(!t || !sndState.xcpAwaitingArea) return;
  if(!runtoFailed(text)) return;
  sndState.xcpAwaitingArea=null;
  sndState.xcpRuntoTarget=null;
  appendOutput('[S&D] runto was refused for '+t.areaName+'; skipping this target.\n','error');
  xcpAbandonTarget(t, 'runto refused');
}

export function xcpStep(t){
  // Normalize target area on the fly for unknown-type targets.
  if(t.type==='unknown' || !t.areaUid){
    const resolvedArea=resolveAreaUid(t.areaName);
    if(resolvedArea){ t.areaName=resolvedArea; t.area=resolvedArea; t.areaUid=resolvedArea; t.type='area'; }
  }
  // 1. Recall + runto to the target area first, unless we already know we are in it.
  // where only works inside the target area, so this is required for reliable routing.
  // We skip recall when currentRoom.area matches the target area (avoids recalling out of the area).
  // Use a broader check that also tolerates short area prompts like [hedge] vs Hedgehogs' Paradise.
  const alreadyInArea=currentRoom.area && (
    t.areaName.toLowerCase().includes(currentRoom.area.toLowerCase()) ||
    currentRoom.area.toLowerCase().includes(t.areaName.toLowerCase()) ||
    areaNameMatches(t.areaName, currentRoom.area)
  );
  if(t.areaUid && !t.recallSent && !alreadyInArea){
    const area=lookupArea(t.areaName);
    if(!area){
      appendOutput('[S&D] no runto keyword for "'+t.areaName+'"; skipping this target.\n','error');
      xcpAbandonTarget(t, 'unknown area');
      return;
    }
    if(area.nogo){
      // Clan halls, mazes, epic areas: runto has no entry for these and walking
      // in is not something we can plan. Say so and move on instead of looping.
      appendOutput('[S&D] "'+t.areaName+'" cannot be auto-navigated (no route exists). '
        + 'Walk there yourself, then /xcp '+t.index+'.\n','error');
      xcpAbandonTarget(t, 'no-go area');
      return;
    }
    if(area.lock && charLevel && charLevel < area.lock){
      appendOutput('[S&D] "'+t.areaName+'" is locked until level '+area.lock
        + ' (you are '+charLevel+'); skipping.\n','error');
      xcpAbandonTarget(t, 'level locked');
      return;
    }
    if(area.guessed){
      appendOutput('[S&D] no keyword on record for "'+t.areaName+'"; guessing "'+area.key
        + '". Run /areas to learn the real list.\n','system');
    }
    const kw=area.key;
    t.recallSent=true;
    sndState.xcpAwaitingArea=t.areaName.toLowerCase();
    sndState.xcpRuntoTarget=t;
    appendOutput('[S&D] recalling to '+t.areaName+' (rt '+kw+')...\n','quest');
    xcpRecall(t, ()=>{
      sendCmd('rt '+kw);
      // If the area never turns up, abandon this target. The old code carried on
      // to `where` anyway -- but `where` only works inside the target area, so
      // that just burned commands in the wrong place and never converged.
      sndState.xcpAwaitingTimer=setTimeout(()=>{
        if(sndState.xcpAwaitingArea){
          sndState.xcpAwaitingArea=null;
          appendOutput('[S&D] never arrived in '+t.areaName+' after runto; skipping.\n','error');
          xcpAbandonTarget(t, 'runto did not arrive');
        }
      }, 12000);
    });
    return;
  }
  // 2. Locate exact instance via where. Ensure target area is imported first so room names are resolvable.
  if(!t.located){
    if(t.type==='unknown' || !t.areaUid){
      const found=findAreaAnywhere(t.areaName);
      if(found){ t.areaName=found; t.area=found; t.areaUid=found; t.type='area'; }
    }
    // If area was just discovered and we haven't recalled yet, run the recall step first.
    if(t.areaUid && !t.recallSent){
      xcpStep(t);
      return;
    }
    // For campaign-hunt mode, enumerate instances with where 1.<full name>, where 2.<full name>, etc.
    if(sndState.xcpMode==='ch' || sndState.xcpMode==='ht'){
      if(!t.whereInstances){
        appendOutput('[S&D] locating '+t.mob+' instances...\n','quest');
        t.whereInstances=[];
        t.whereIndex=1;
        xcpQueryWhereInstance(t, 1);
        return;
      }
    } else {
      // nearest / qw: single where with short keyword
      appendOutput('[S&D] locating '+t.mob+' instances...\n','quest');
      sendCmd('where '+t.htkw);
    }
    return;
  }
  // 3. Mode-specific instance handling
  if(sndState.xcpMode==='nearest'){
    if(!t.campaignInstance){
      xcpRunNearest(t);
      return;
    }
  } else if(sndState.xcpMode==='ch'){
    // Campaign hunt: test each where instance with hunt n.<full mob name>.
    // The campaign mob is the one that cannot be hunted.
    if(!t.campaignInstance){
      if(!t.whereInstances || t.whereInstances.length===0){
        appendOutput('[S&D] no campaign-hunt candidates found.\n','quest');
        sndState.pendingXcp=null;
        return;
      }
      xcpRunCampaignHunt(t);
      return;
    }
  } else {
    // Classic hunt trick mode
    if(!t.campaignInstance){
      xcpRunHuntTrick(t);
      return;
    }
  }
  // 4. Move to the identified instance's room
  xcpGotoInstance(t);
}

export function xcpRunNearest(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Resolve all instance room names to UIDs and pick nearest to current room
  if(!t.nearestQueue){
    const resolved=[];
    for(const inst of t.whereInstances){
      let room=null;
      if(inst.roomUid){
        room={uid:inst.roomUid, name:inst.roomName};
      } else if(inst.roomName){
        room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
      }
      if(room) resolved.push({...inst, roomUid:room.uid, roomName:room.name});
    }
    if(resolved.length===0){
      appendOutput('[S&D] No where instances could be resolved to mapped rooms; falling back to hunt trick.\n','quest');
      sndState.xcpMode='ht';
      xcpRunHuntTrick(t);
      return;
    }
    // Sort by real path length, nearest first.
    const dists={};
    for(const r of resolved){
      const path=findPath(currentRoom.uid, r.roomUid);
      dists[r.roomUid]=path?path.length:Infinity;
    }
    resolved.sort((a,b)=>dists[a.roomUid]-dists[b.roomUid]);
    t.nearestQueue=resolved.slice();
    t.nearestIndex=0;
    appendOutput('[S&D] nearest mode: '+resolved.length+' candidate room(s)\n','quest');
  }
  if(t.nearestIndex>=t.nearestQueue.length){
    appendOutput('[S&D] nearest mode exhausted all candidates without kill confirmation. Switching to hunt trick.\n','quest');
    t.nearestQueue=null;
    sndState.xcpMode='ht';
    xcpRunHuntTrick(t);
    return;
  }
  const inst=t.nearestQueue[t.nearestIndex];
  t.campaignInstance=inst;
  appendOutput('[S&D] nearest candidate #'+(t.nearestIndex+1)+': '+inst.roomName+'\n','quest');
  xcpGotoInstance(t);
}

export function xcpRunCampaignHunt(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Work through instances 1..N
  if(t.huntTrickIndex===undefined || t.huntTrickIndex<1) t.huntTrickIndex=1;
  if(t.huntTrickIndex>t.whereInstances.length){
    appendOutput('[S&D] all instances tested; no campaign mob found.\n','quest');
    sndState.pendingXcp=null;
    return;
  }
  const inst=t.whereInstances[t.huntTrickIndex-1];
  t.campaignInstance=inst;
  appendOutput('[S&D] testing instance '+inst.n+' with campaign hunt...\n','quest');
  xcpContinueCampaignHunt(t, inst);
}

export function xcpQueryWhereInstance(t, n){
  t.whereIndex=n;
  t.whereAwaiting=n;
  const full=t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'');
  appendOutput('[S&D] querying instance '+n+': where '+n+'.'+full+'\n','quest');
  sendCmd('where '+n+'.'+full);
  t.whereTimeout=setTimeout(()=>{
    if(t.whereAwaiting===n){
      appendOutput('[S&D] where '+n+' timed out; stopping enumeration at '+(n-1)+' instance(s).\n','quest');
      t.whereAwaiting=null;
      t.located=true;
      if(sndState.pendingXcp) xcpStep(sndState.pendingXcp);
    }
  }, 5000);
}

export function xcpRunHuntTrick(t){
  if(!t.whereInstances || t.whereInstances.length===0){
    appendOutput('[S&D] no instances found; retrying where in 3s...\n','quest');
    t.located=false;
    setTimeout(()=>xcpStep(t), 3000);
    return;
  }
  // Start from instance 1 upward
  if(t.huntTrickIndex===undefined || t.huntTrickIndex<1) t.huntTrickIndex=1;
  if(t.huntTrickIndex>t.whereInstances.length){
    appendOutput('[S&D] hunt trick did not identify target, using last instance.\n','quest');
    t.campaignInstance=t.whereInstances[t.whereInstances.length-1];
    xcpKillTarget(t);
    return;
  }
  const inst=t.whereInstances[t.huntTrickIndex-1];
  t.huntTrickSteps=0;
  appendOutput('[S&D] hunt trick '+t.huntTrickIndex+'/'+t.whereInstances.length+'...\n','quest');
  xcpContinueHuntTrick(t, inst);
}

export function xcpContinueCampaignHunt(t, inst){
  clearTimeout(sndState.huntTrickTimeout||null);
  sndState.pendingHuntTrick={target:t, instance:inst, at:Date.now(), responded:false};
  sndState.huntTrickTimeout=setTimeout(()=>{
    const h=sndState.pendingHuntTrick;
    if(h && !h.responded){
      appendOutput('[S&D] no hunt response while testing instance '+inst.n+', trying next.\n','quest');
      sndState.pendingHuntTrick=null;
      t.huntTrickIndex++;
      xcpRunCampaignHunt(t);
    }
  }, 3500);
  // Use the FULL mob name for campaign hunt verification: hunt fails on the real campaign target.
  const huntArg=inst.n+'.'+t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'');
  sendCmd('hunt '+huntArg);
}

export function xcpGotoInstance(t){
  const inst=t.campaignInstance;
  if(!inst){
    runtoArea(t.areaName);
    xcpScheduleAction(t);
    return;
  }
  // If we're already in the room, just kill.
  if(currentRoom.name && currentRoom.name.toLowerCase()===inst.roomName.toLowerCase()){
    appendOutput('[S&D] already in target room.\n','quest');
    xcpKillTarget(t);
    return;
  }
  appendOutput('[S&D] identified instance in '+inst.roomName+'\n','quest');
  // Use a non-campaign instance to navigate. Find the first instance that is NOT the campaign instance
  // and is in a different room, then follow hunt directions until we reach the target room.
  const navInst=(t.whereInstances||[]).find(i=>i!==inst && i.roomName && i.roomName.toLowerCase()!==inst.roomName.toLowerCase()) || null;
  if(navInst){
    appendOutput('[S&D] navigating via non-campaign instance '+navInst.n+' in '+navInst.roomName+'\n','quest');
    sndState.xcpNav={target:t, targetInstance:inst, navInstance:navInst, phase:'hunt', startName:currentRoom.name, steps:0};
    xcpFollowHuntInstance(t, navInst);
    return;
  }
  // If all instances are in the same room, try following by mob keyword (un-numbered hunt) instead.
  const kw=gmkw(t.mob);
  if(kw){
    appendOutput('[S&D] all instances in same room; navigating by keyword hunt '+kw+'\n','quest');
    sndState.xcpNav={target:t, targetInstance:inst, navInstance:null, phase:'kw', startName:currentRoom.name, steps:0};
    xcpFollowHuntByKeyword(t, kw);
    return;
  }
  // Fallback: try direct room resolution (may be unreliable if map doesn't match live exits).
  let room=null;
  if(inst.roomUid){
    room={uid:inst.roomUid, name:inst.roomName};
  } else if(inst.roomName){
    room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
  }
  if(room){
    appendOutput('[S&D] using mapped path to '+inst.roomName+'\n','quest');
    gotoRoomUid(room.uid, ()=>xcpKillTarget(t));
    return;
  }
  appendOutput('[S&D] room "'+inst.roomName+'" not mapped locally; open Gaardian map manually: '+t.areaName+' - '+inst.roomName+'\n','quest');
  window.open('https://maps.gaardian.com/', '_blank');
}

export function xcpFollowHuntInstance(t, navInst){
  const xn=sndState.xcpNav;
  if(!xn) return;
  // Check if we already arrived at target room by name.
  if(currentRoom.name && xn.targetInstance && currentRoom.name.toLowerCase()===xn.targetInstance.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at target room '+currentRoom.name+'\n','quest');
    sndState.xcpNav=null;
    xcpKillTarget(t);
    return;
  }
  // Check if the nav instance still points to a different room; if so, follow it.
  if(currentRoom.name && navInst.roomName && currentRoom.name.toLowerCase()===navInst.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at nav instance room '+currentRoom.name+', but target instance is elsewhere. Trying direct route.\n','quest');
    sndState.xcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
    return;
  }
  // Follow hunt for the nav instance. Parse directional output from Aardwolf.
  sndState.pendingXcpNav={target:t, nav:navInst, at:Date.now()};
  appendOutput('[S&D] following hunt '+navInst.n+'...\n','quest');
  sendCmd('hunt '+navInst.n+'.'+t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,''));
  sndState.xcpNav.huntTimeout=setTimeout(()=>{
    appendOutput('[S&D] hunt navigation timed out; trying direct path.\n','quest');
    sndState.pendingXcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
  }, 4000);
}

export function xcpTryDirectPath(t, inst){
  let room=null;
  if(inst.roomUid){
    room={uid:inst.roomUid, name:inst.roomName};
  } else if(inst.roomName){
    room=resolveRoomByNameAnywhere(inst.roomName, t.areaName);
  }
  if(room){
    appendOutput('[S&D] using mapped fallback path to '+inst.roomName+'\n','quest');
    gotoRoomUid(room.uid, ()=>xcpKillTarget(t));
    return;
  }
  // No mapped route. In a maze the map was never going to help -- the room
  // layout is not expressible as a grid -- so hand navigation to the server's
  // own hunt skill and follow it a step at a time. This is what
  // Search-and-Destroy's autohunt does, and it is the answer for the areas
  // where the helper used to give up.
  appendOutput('[S&D] no mapped route; switching to autohunt.\n','quest');
  startAutoHunt(t);
}

// -----------------------------------------------------------------------------
// Autohunt: server-driven navigation for mazes and unmapped areas
// -----------------------------------------------------------------------------
const HUNT_DIRS = {north:'n', south:'s', east:'e', west:'w', northeast:'ne',
                   northwest:'nw', southeast:'se', southwest:'sw', up:'u', down:'d'};
const HUNT_DIR_RE = /(?:is|heading|leading|fled|went|go|toward)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)\b/i;
const HUNT_ARRIVED = /is here|right here|in this (?:very )?room/i;
const HUNT_THROUGH = /\bis through\b|\bpassed through here, heading through\b/i;
const HUNT_FAIL = /couldn't find a path|No one in this area by the name|unable to hunt that target|You are not hunting/i;
const MAX_HUNT_STEPS = 40;

export function isMazeHere(){
  return /\bmaze\b/i.test(String(currentRoom.info || ''));
}

/**
 * `/ah <keyword>` -- follow the MUD's own `hunt` skill to a mob, one step at a
 * time, and stop when you are in its room.
 *
 * This is the same loop the campaign helper uses in mazes, driven directly.
 * It only works inside the mob's area (that is a `hunt` limitation, not ours),
 * it opens closed doors it is told to walk through, and it gives up on portals.
 */
export function huntTo(keyword){
  const kw=String(keyword||'').trim().replace(/"/g,'');
  if(!kw){ appendOutput('[ah] usage: /ah <mob keyword>   (/ah off to stop)\n','system'); return; }
  if(/^(off|stop|abort)$/i.test(kw)){ stopAutoHunt('cancelled'); return; }
  if(isWalking()) cancelWalk('autohunt');
  appendOutput('[ah] hunting "'+kw+'" -- will stop when you reach it. /ah off to cancel.\n','quest');
  sndState.autoHunt={target:null, kw, steps:0, lastDir:null, opened:false, timer:null};
  huntStep();
}

export function startAutoHunt(t){
  if(isWalking()) cancelWalk('autohunt');
  const kw=(t.htkw || gmkw(t.mob) || '').replace(/"/g,'') || t.mob;
  sndState.autoHunt={target:t, kw, steps:0, lastDir:null, opened:false, timer:null};
  huntStep();
}

export function stopAutoHunt(reason){
  const ah=sndState.autoHunt;
  if(!ah) return;
  if(ah.timer) clearTimeout(ah.timer);
  sndState.autoHunt=null;
  if(reason) appendOutput('[S&D] autohunt stopped: '+reason+'\n','error');
}

function huntStep(){
  const ah=sndState.autoHunt;
  if(!ah) return;
  if(ah.steps++ > MAX_HUNT_STEPS){ stopAutoHunt('trail too long'); return; }
  if(charState===STATE_FIGHTING){ ah.timer=setTimeout(huntStep, 1500); return; }
  sendCmdRaw('hunt '+ah.kw);
  ah.timer=setTimeout(()=>stopAutoHunt('no hunt response'), 6000);
}

/** Drive autohunt from MUD output. Returns true if the text was consumed. */
export function parseAutoHuntOutput(text){
  const ah=sndState.autoHunt;
  if(!ah) return false;
  const clean=stripAnsi(text);
  if(ah.timer){ clearTimeout(ah.timer); ah.timer=null; }

  if(HUNT_FAIL.test(clean)){ stopAutoHunt('hunt cannot find the target'); return true; }
  if(HUNT_THROUGH.test(clean)){
    stopAutoHunt('target is through a portal -- enter it manually, then /xcp again');
    return true;
  }
  if(HUNT_ARRIVED.test(clean)){
    const t=ah.target;
    sndState.autoHunt=null;
    if(t){
      appendOutput('[S&D] autohunt arrived at the target.\n','quest');
      xcpKillTarget(t);
    } else {
      // Standalone /ah: walk the player there and stop. Landing the killing
      // blow is theirs to do -- see the note about triggers that kill in
      // HANDOVER.md section 0.
      appendOutput('[ah] you are in the room with "'+ah.kw+'". Stopping here.\n','quest');
      try{ if('vibrate' in navigator) navigator.vibrate([40,60,40]); }catch(e){}
    }
    return true;
  }
  const m=clean.match(HUNT_DIR_RE);
  if(m){
    const dir=HUNT_DIRS[m[1].toLowerCase()];
    if(dir){
      ah.lastDir=dir;
      // GMCP publishes only open exits, so a hunt direction that is missing
      // from the room is a closed door. Open it before walking into it.
      const available=(currentRoom.exits||[]).map(d=>String(d).toLowerCase());
      if(available.length && !available.includes(dir) && !ah.opened){
        ah.opened=true;
        sendCmdRaw('open '+dir);
        ah.timer=setTimeout(huntStep, 800);
        return true;
      }
      ah.opened=false;
      sendCmdRaw(dir);
      ah.timer=setTimeout(huntStep, 900);
      return true;
    }
  }
  // Not a line we understand; keep waiting for the real response.
  ah.timer=setTimeout(()=>stopAutoHunt('no usable hunt direction'), 5000);
  return false;
}

export function xcpFollowHuntByKeyword(t, kw){
  const xn=sndState.xcpNav;
  if(!xn || xn.phase!=='kw') return;
  // Check arrival by target room name.
  if(currentRoom.name && xn.targetInstance && currentRoom.name.toLowerCase()===xn.targetInstance.roomName.toLowerCase()){
    appendOutput('[S&D] arrived at target room '+currentRoom.name+'\n','quest');
    sndState.xcpNav=null;
    xcpKillTarget(t);
    return;
  }
  // For keyword hunt, use the unquoted mob name without article.
  const bareKw=t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'').trim();
  sndState.pendingXcpNav={target:t, nav:null, kw:kw, at:Date.now()};
  appendOutput('[S&D] following hunt '+bareKw+'...\n','quest');
  sendCmd('hunt '+bareKw);
  sndState.xcpNav.huntTimeout=setTimeout(()=>{
    appendOutput('[S&D] keyword hunt timed out; trying direct path.\n','quest');
    sndState.pendingXcpNav=null;
    xcpTryDirectPath(t, xn.targetInstance);
  }, 4000);
}

// Hook into hunt-response parsing for navigation instances.
export function parseXcpNavOutput(text){
  const n=sndState.pendingXcpNav;
  if(!n) return;
  const clean=stripAnsi(text).toLowerCase();
  const lines=clean.split(/\r?\n/);
  n.responded=true;
  clearTimeout((sndState.xcpNav||{}).huntTimeout||null);
  sndState.pendingXcpNav=null;
  const t=n.target;
  const nav=n.nav;

  // Directional hunt: parse explicit direction lines from Aardwolf.
  const dirLine=lines.find(line=>(/(confident|heading|trail)/i.test(line) && /(?:heading|leading|fled|went|go|to|toward|direction)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i.test(line)));
  if(dirLine){
    const dirMatch=dirLine.match(/(?:heading|leading|fled|went|go|to|toward|direction)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i);
    const dirMap={north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',up:'u',down:'d'};
    const dir=dirMap[dirMatch[1].toLowerCase()];
    if(dir){
      sndState.xcpNav.steps=(sndState.xcpNav.steps||0)+1;
      if(sndState.xcpNav.steps>25){
        appendOutput('[S&D] nav trail too long, stopping.\n','quest');
        sndState.xcpNav=null;
        return;
      }
      appendOutput('[S&D] hunt indicates '+dirMatch[1].toLowerCase()+', moving...\n','quest');
      sendCmd(dir);
      const nav=sndState.xcpNav.navInstance;
      const kw=sndState.xcpNav.kw;
      setTimeout(()=>{
        if(kw) xcpFollowHuntByKeyword(t, kw);
        else if(nav) xcpFollowHuntInstance(t, nav);
      }, 1500);
      return;
    }
  }

  // If we reached the mob, we are in its room.
  const here=/you\s+(?:attack|slash|pierce|crush|whip|hit|maul|cleave)|you\s+start\s+hunting/i;
  if(lines.some(line=>here.test(line))){
    appendOutput('[S&D] reached hunt target room.\n','quest');
    if(currentRoom.name && t.campaignInstance && currentRoom.name.toLowerCase()===t.campaignInstance.roomName.toLowerCase()){
      xcpKillTarget(t);
    } else {
      sndState.xcpNav=null;
      xcpTryDirectPath(t, t.campaignInstance);
    }
    return;
  }

  // Otherwise fall back to direct path.
  appendOutput('[S&D] no direction from hunt; trying direct path.\n','quest');
  sndState.xcpNav=null;
  xcpTryDirectPath(t, t.campaignInstance);
}

export function collectRoomNamesForArea(areaName){
  const names=[];
  if(!areaName) return names;
  if(sqlDb){
    const res=sqlDb.exec('SELECT DISTINCT name FROM rooms WHERE LOWER(area)=LOWER(?)', [areaName]);
    if(res.length && res[0].values) names.push(...res[0].values.map(r=>r[0]));
  }
  if(gaardianDb && names.length<5){
    const res=gaardianDb.exec(`SELECT r.roomname FROM rooms r JOIN areas a ON a.areaid=r.areaid WHERE LOWER(a.areaname) LIKE ?`, ['%'+areaName.toLowerCase()+'%']);
    if(res.length && res[0].values) names.push(...res[0].values.map(r=>r[0]));
  }
  return [...new Set(names)].sort((a,b)=>b.length-a.length);
}

// -----------------------------------------------------------------------------
// Mob sightings
// -----------------------------------------------------------------------------
// Remember where each mob has actually been seen, so that when both `hunt` and
// `where` come up empty there is still somewhere to suggest. Ranked by how
// often we have seen it there.

export function recordSightings(mob, areaName, instances){
  if(!sqlDb || !mob || !instances || !instances.length) return;
  const now=new Date().toISOString();
  const a=(areaName||currentRoom.area||'').toLowerCase();
  for(const inst of instances){
    if(!inst.roomName) continue;
    try {
      sqlDb.run(
        `INSERT INTO mobs(mob, area, room, room_uid, seen_count, last_seen)
         VALUES (?,?,?,?,1,?)
         ON CONFLICT(mob, area, room) DO UPDATE
           SET seen_count=seen_count+1, last_seen=excluded.last_seen,
               room_uid=COALESCE(excluded.room_uid, mobs.room_uid)`,
        [mob.toLowerCase(), a, inst.roomName, inst.roomUid || null, now]);
    } catch(e){ console.error('recordSightings', e); }
  }
}

export function knownSightings(mob, areaName){
  if(!sqlDb || !mob) return [];
  try {
    const res=sqlDb.exec(
      `SELECT room, room_uid, seen_count FROM mobs
        WHERE mob=? AND (?='' OR area=?) ORDER BY seen_count DESC, room LIMIT 5`,
      [mob.toLowerCase(), (areaName||'').toLowerCase(), (areaName||'').toLowerCase()]);
    return (res[0]?.values||[]).map(r=>({roomName:r[0], roomUid:r[1], count:r[2]}));
  } catch(e){ return []; }
}

export function parseWhereOutput(text){
  const t=sndState.pendingXcp;
  if(!t || t.located) return;
  const clean=stripAnsi(text);
  const lines=clean.split(/\r?\n/);
  const instances=[];
  const fallback=[];
  const kw=(t.htkw||'').toLowerCase();
  const targetMob=t.mob.toLowerCase();
  // Load candidate room names for the target area to do suffix matching.
  const areaRoomNames=collectRoomNamesForArea(t.areaName);

  for(const rawLine of lines){
    const line=rawLine.trim();
    if(!line) continue;
    // Skip echo of the command itself and informational/no-match lines.
    if(/^where\s/i.test(line)) continue;
    if(/There is no|around here|can't find any|no such/i.test(line)){
      // In numbered enumeration, an explicit no-match line ends the loop.
      if((sndState.xcpMode==='ch' || sndState.xcpMode==='ht') && t.whereAwaiting){
        clearTimeout(t.whereTimeout||null);
        t.whereAwaiting=null;
        appendOutput('[S&D] enumerated '+t.whereInstances.length+' instance(s)\n','quest');
        t.located=true;
        setTimeout(()=>xcpStep(t), 100);
      }
      continue;
    }

    let roomName=null, mobCol=null, n=1;

    // Numbered lines like "1. Aorzloi the head triage doctor The triage"
    const numMatch=line.match(/^\s*(\d+)\.\s+(.+)$/);
    if(numMatch){ n=parseInt(numMatch[1]); mobCol=numMatch[2]; }
    else { mobCol=line; }

    // Aardwolf's `where` output is fixed-width: the mob name occupies exactly
    // 30 columns and the room name starts at column 32. Split on that first --
    // it is exact, and it works for rooms we have never seen. The fuzzy
    // suffix-matching below only runs when the column split does not apply
    // (wrapped lines, unusual output).
    const col=mobCol.match(/^(.{30}) (\S.*)$/);
    if(col && !/^\d/.test(col[2])){
      roomName=col[2].trim();
      mobCol=col[1].trim();
    }

    // Find longest known room name that is a suffix of mobCol.
    if(!roomName && areaRoomNames.length){
      const lowerMobCol=mobCol.toLowerCase();
      for(const candidate of areaRoomNames){
        const c=candidate.toLowerCase();
        if(lowerMobCol.endsWith(' '+c) || lowerMobCol===c){
          const idx=lowerMobCol.lastIndexOf(c);
          roomName=candidate;
          mobCol=mobCol.slice(0, idx).trim().replace(/\s+$/,'');
          break;
        }
      }
    }
    // Fuzzy fallback: the where line may be truncated. Find the candidate whose last
    // words are the suffix of the line, or whose last words match the START of a room name.
    if(!roomName && areaRoomNames.length){
      const lowerMobCol=mobCol.toLowerCase();
      const lineWords=lowerMobCol.split(/\s+/).filter(Boolean);
      for(const candidate of areaRoomNames){
        const cwords=candidate.toLowerCase().split(/\s+/).filter(Boolean);
        if(!cwords.length) continue;
        // Try matching the last 1-4 words of candidate against the end of the line.
        for(let take=1; take<=Math.min(4, cwords.length); take++){
          const suffix=cwords.slice(-take).join(' ');
          if(lowerMobCol.endsWith(' '+suffix) || lowerMobCol===suffix){
            roomName=candidate;
            mobCol=mobCol.slice(0, lowerMobCol.lastIndexOf(suffix)).trim();
            break;
          }
        }
        // Also try matching the last words of the line against the start of the room name.
        if(!roomName && lineWords.length){
          for(let take=1; take<=Math.min(4, lineWords.length); take++){
            const prefix=lineWords.slice(-take).join(' ');
            const candStart=cwords.slice(0, take).join(' ');
            if(prefix===candStart){
              roomName=candidate;
              mobCol=mobCol.slice(0, lowerMobCol.lastIndexOf(prefix)).trim();
              break;
            }
          }
        }
        if(roomName) break;
      }
    }

    // Fallback to the old double-space split if no room name matched.
    if(!roomName){
      const parts=mobCol.split(/\s{2,}/);
      if(parts.length>=2){
        mobCol=parts.slice(0,-1).join(' ');
        roomName=parts[parts.length-1];
      }
    }

    if(!roomName) continue;
    const mobLower=mobCol.toLowerCase();

    // In campaign-hunt mode, the where output must match the exact full mob name.
    // Reject lines like "an apple-carrying hedgehog" when target is "a large apple tree".
    const fullMob=t.mob.toLowerCase().replace(/^\s*(a|an|the)\s+/i,'');
    const fullMobWords=fullMob.split(/\s+/).filter(Boolean);
    if(sndState.xcpMode==='ch' || sndState.xcpMode==='ht'){
      // Require every word of the full mob name to appear in order in the mob column.
      let mi=0;
      const mobWords=mobLower.split(/\s+/).filter(Boolean);
      for(const w of mobWords){
        if(mi<fullMobWords.length && w===fullMobWords[mi]) mi++;
      }
      if(mi!==fullMobWords.length){
        // Not a matching mob line for this target; treat as a fallback only if no better match exists.
        if(/someone|somebody|something/i.test(mobLower)) fallback.push({n, roomName, roomUid:null, generic:true});
        continue;
      }
      instances.push({n, roomName, roomUid:null});
      continue;
    }

    // For other modes, include if mob column matches target name or contains the keyword.
    if(mobMatches(t.mob, mobLower) || (kw && mobLower.includes(kw))){
      instances.push({n, roomName, roomUid:null});
    } else if(/someone|somebody|something/i.test(mobLower)){
      fallback.push({n, roomName, roomUid:null, generic:true});
    }
  }
  let use = instances.length ? instances : fallback;
  if(use.length===0) return; // not a where block we can parse
  if(instances.length===0 && fallback.length>0){
    appendOutput('[S&D] where hid the mob name; using '+fallback.length+' generic candidate(s).\n','quest');
  }
  // For numbered enumeration (campaign hunt / hunt trick), add the single result to the target list and continue.
  if((sndState.xcpMode==='ch' || sndState.xcpMode==='ht') && t.whereAwaiting){
    clearTimeout(t.whereTimeout||null);
    const n=t.whereAwaiting;
    t.whereAwaiting=null;
    if(use.length>0){
      const inst=use[0];
      inst.n=n;
      t.whereInstances.push(inst);
      t.whereIndex=n+1;
      appendOutput('[S&D] instance '+n+' found: '+inst.roomName+'\n','quest');
      xcpQueryWhereInstance(t, n+1);
    } else {
      // No match for this number means enumeration is done.
      appendOutput('[S&D] enumerated '+t.whereInstances.length+' instance(s)\n','quest');
      t.located=true;
      xcpStep(t);
    }
    return;
  }
  t.whereInstances=use;
  t.located=true;
  recordSightings(t.mob, t.areaName, use);
  // If target area is unknown, try to discover it from the first resolved room name.
  if(t.type==='unknown' || !t.areaUid){
    for(const inst of use){
      const rooms=resolveRoomByNameAnywhere(inst.roomName, null);
      if(rooms){
        t.areaName=rooms.area;
        t.area=rooms.area;
        t.areaUid=rooms.area;
        t.type='area';
        break;
      }
    }
  }
  appendOutput('[S&D] found '+use.length+' instance(s) of '+t.mob+'\n','quest');
  xcpStep(t);
}

export function parseHuntTrickOutput(text){
  const h=sndState.pendingHuntTrick;
  if(!h) return;
  const clean=stripAnsi(text).toLowerCase();
  const lines=clean.split(/\r?\n/);
  const target=h.target;
  const inst=h.instance;
  h.responded=true;
  clearTimeout(sndState.huntTrickTimeout||null);

  const unable=/unable\s+to\s+hunt\s+that\s+target|seem\s+unable\s+to\s+hunt|campaign.*unable/i;
  if(lines.some(line=>unable.test(line))){
    appendOutput('[S&D] campaign instance '+inst.n+' is the target.\n','quest');
    target.campaignInstance=inst;
    sndState.pendingHuntTrick=null;
    if(sndState.xcpMode==='ch'){
      // In campaign-hunt mode we are not necessarily in the room; route there first.
      xcpGotoInstance(target);
    } else {
      xcpKillTarget(target);
    }
    return;
  }

  // Directional hunt: only from explicit hunt-result lines like "heading east"
  const dirLine=lines.find(line=>/(confident|heading|trail)/i.test(line) && /(?:heading|leading|fled|went|go|to|toward|direction)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i.test(line));
  if(dirLine){
    const dirMatch=dirLine.match(/(?:heading|leading|fled|went|go|to|toward|direction)\s+(?:the\s+)?(north(?:east|west)?|south(?:east|west)?|east|west|up|down)/i);
    const dirMap={north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',up:'u',down:'d'};
    const dir=dirMap[dirMatch[1].toLowerCase()];
    if(dir){
      target.huntTrickSteps=(target.huntTrickSteps||0)+1;
      if(target.huntTrickSteps>25){
        appendOutput('[S&D] instance '+inst.n+' trail too long, trying next.\n','quest');
        sndState.pendingHuntTrick=null;
        target.huntTrickIndex++;
        setTimeout(()=> sndState.xcpMode==='ch'?xcpRunCampaignHunt(target):xcpRunHuntTrick(target), 600);
        return;
      }
      appendOutput('[S&D] instance '+inst.n+' is '+dirMatch[1].toLowerCase()+', moving...\n','quest');
      sndState.pendingHuntTrick=null;
      sendCmd(dir);
      setTimeout(()=>xcpContinueHuntTrick(target, inst), 1200);
      return;
    }
  }

  const notHere=/you\s+can't\s+find\s+any|they\s+aren't\s+here|you\s+don't\s+see|no\s+such\s+creature|is\s+not\s+here|unable\s+to\s+see|no\s+trail|lost\s+(?:the\s+)?trail/i;
  const attackStart=/you\s+(?:start\s+)?hunting|you\s+attack|you\s+(?:slash|pierce|crush|whip|hit|maul|cleave)/i;
  if(lines.some(line=>notHere.test(line) || attackStart.test(line))){
    appendOutput('[S&D] instance '+inst.n+' is not the target.\n','quest');
    sndState.pendingHuntTrick=null;
    target.huntTrickIndex++;
    setTimeout(()=> sndState.xcpMode==='ch'?xcpRunCampaignHunt(target):xcpRunHuntTrick(target), 600);
    return;
  }
}

export function xcpContinueHuntTrick(t, inst){
  clearTimeout(sndState.huntTrickTimeout||null);
  sndState.pendingHuntTrick={target:t, instance:inst, at:Date.now(), responded:false};
  sndState.huntTrickTimeout=setTimeout(()=>{
    const h=sndState.pendingHuntTrick;
    if(h && !h.responded){
      appendOutput('[S&D] no hunt response while following instance '+inst.n+', trying next.\n','quest');
      sndState.pendingHuntTrick=null;
      t.huntTrickIndex++;
      xcpRunHuntTrick(t);
    }
  }, 3500);
  sendCmd('hunt '+inst.n+'.'+t.htkw);
}

export function xcpKillTarget(t){
  if(t.is_dead) return;
  const kw=gmkw(t.mob);
  appendOutput('[S&D] killing '+t.mob+' (kill '+kw+')...\n','quest');
  sendCmd('kill '+kw);
  setTimeout(()=>xcpVerifyKill(t, ()=>{
    appendOutput('[S&D] '+t.mob+' still alive; finish the fight and /xcp to continue.\n','quest');
  }), 5000);
}

export function mobMatches(targetMob, lineMob){
  const omit={a:1,an:1,the:1,of:1,in:1,on:1,at:1,with:1,from:1,to:1,and:1};
  const targetWords=targetMob.toLowerCase().replace(/[^\w\s-]/g,' ').split(/\s+/).filter(w=>w&&!omit[w]);
  const lineWords=lineMob.toLowerCase().replace(/[^\w\s-]/g,' ').split(/\s+/).filter(w=>w);
  let ti=0;
  for(const w of lineWords){
    if(ti<targetWords.length && w===targetWords[ti]) ti++;
  }
  return ti===targetWords.length;
}

export function parseHuntOutput(text){
  // First, handle campaign-hunt testing and nav-instance following.
  const h=sndState.pendingHuntTrick;
  const n=sndState.pendingXcpNav;
  if(n) parseXcpNavOutput(text);
  if(h) parseHuntTrickOutput(text);
  // Keep existing parseHuntOutput for regular hunt mode if needed
  const hunt=sndState.pendingHunt;
  if(!hunt) return;
  const clean=stripAnsi(text).toLowerCase();
  const target=hunt.target;
  const foundPatterns=[/is here/i,/you start hunting/i,/you hunt/i,/you begin hunting/i,/you attack/i,/you slash/i,/you pierce/i,/you crush/i,/you whip/i,/you hit/i];
  const notHerePatterns=[/you can't find any.*here/i,/they aren't here/i,/you don't see.*here/i,/no such creature/i,/is not here/i];
  if(foundPatterns.some(p=>p.test(clean))){
    hunt.found=true;
    appendOutput('[S&D] '+target.mob+' is here! Killing...\n','quest');
    sendCmd('kill '+target.kw);
    sndState.pendingHunt=null;
  } else if(notHerePatterns.some(p=>p.test(clean))){
    hunt.found=false;
    appendOutput('[S&D] '+target.mob+' not in this room.\n','quest');
    sndState.pendingHunt=null;
  }
}

export function xcpVerifyKill(t, onStillAlive){
  // Send cp check; callback runs after result arrives
  sndState.pendingCpCheckCallback=(dead)=>{
    if(dead){
      appendOutput('[S&D] '+t.mob+' confirmed dead. Moving to next target.\n','quest');
      xcpNext();
    } else {
      onStillAlive();
    }
  };
  sendCmd('cp check');
}

export function xcpScheduleAction(t){
  if(sndState.xcpMode==='ht') setTimeout(()=>sendCmd('hunt '+t.kw), 600);
  else if(sndState.xcpMode==='qw') setTimeout(()=>sendCmd('where '+t.kw), 600);
}

// areaRuntoKeyword lived here as "first word, truncated to 5 chars". It now
// lives in areas.js, backed by the keyword list harvested from the game.

export function xcpTarget(t){
  // Only auto-restart if target is alive and not already actively being routed.
  if(t.is_dead) return;
  if(sndState.pendingXcp && sndState.pendingXcp.index===t.index && (sndState.pendingXcp.campaignInstance || sndState.pendingXcp.located)) return;
  xcpByIndex(t.index);
}

export function renderCampaign(){
  const list=document.getElementById('campaign-list');
  if(!list) return;
  list.innerHTML='';
  const header=document.createElement('div');
  header.style='background:var(--panel);padding:8px;border-radius:6px;margin-bottom:8px;font-size:12px;';
  header.innerHTML='S&D: type='+(sndState.cpType||'none')+' level='+(sndState.cpLevel||'?')+' mode='+(sndState.xcpMode||'ht');
  list.appendChild(header);
  if(campaignTargets.length===0){
    list.innerHTML+='<div style="color:var(--muted);text-align:center;padding:20px;">No campaign data. Type /cpinfo then /cpcheck.</div>';
    return;
  }
  const done=campaignTargets.filter(t=>t.completed).length;
  const progressDiv=document.createElement('div');
  progressDiv.innerHTML='<div style="background:var(--panel);padding:8px;border-radius:6px;margin-bottom:8px;">Progress: <b>'+done+'/'+campaignTargets.length+'</b> done</div>';
  list.appendChild(progressDiv);
  for(const t of campaignTargets){
    const el=document.createElement('div');
    el.className='item';
    el.style.background=t.completed?'rgba(46,204,113,.1)':'rgba(231,76,60,.05)';
    const sub=t.type==='room' ? (t.roomName||'')+' in '+t.areaName : t.areaName;
    el.innerHTML='<b>'+t.index+'. '+t.mob+'</b> <span style="color:var(--muted)">'+sub+'</span> <span style="float:right;color:'+(t.completed?'var(--green)':'var(--yellow)')+'">'+(t.is_dead?'dead':'live')+'</span>';
    el.onclick=()=>{xcpByIndex(t.index);};
    list.appendChild(el);
  }
}

export function setXcpMode(mode){
  const valid=['ht','ch','qw','nearest','off'];
  if(valid.includes(mode)){
    sndState.xcpMode=mode;
    localStorage.setItem('xcp_mode', mode);
    appendOutput('[S&D] xcp mode set to '+mode+'\n','system');
  }
  else { appendOutput('[S&D] Valid modes: ht, ch, qw, nearest, off\n','error'); }
}

export function doHuntTrick(mob){
  if(mob){ sndState.shortMobName=gmkw(mob); }
  if(!sndState.shortMobName){ appendOutput('[S&D] No target. Use /ht <mob> or /xcp first.\n','error'); return; }
  sendCmd('hunt '+sndState.shortMobName);
}

export function doQuickWhere(mob){
  if(mob){ sndState.shortMobName=gmkw(mob); }
  if(!sndState.shortMobName){ appendOutput('[S&D] No target. Use /qw <mob> or /xcp first.\n','error'); return; }
  sendCmd('where '+sndState.shortMobName);
}

export function doCpInfo(){ sendCmd('cp info'); }
export function doCpCheck(){ sendCmd('cp check'); }
export function refreshCampaign(){ togglePanel('campaign'); doCpCheck(); }
