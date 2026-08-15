// chat.js -- keep the conversation out of the combat scroll.
//
// The main window is the only place anything is written, and during a fight it moves
// far too fast to read: one round is a dozen damage lines, and the campaign helper adds
// its own. A clan line or a tell arriving in the middle of that is gone before it can be
// seen -- and unlike a damage line, it is the one thing nobody can replay.
//
// So every line is copied here on its way to the screen, sorted by channel, and kept.
// Nothing is removed from the main window: this is a second view of the same stream,
// not a filter, because a filter that drops a line you wanted is worse than no filter.

// Both helpers come from ui.js, which imports this module back for noteChatLine.
// That circle is fine because every use is inside a function: by the time a line is
// classified or rendered, both modules have finished evaluating.
import { sendCmdRaw } from './net.js';
import { ansiToHtml, stripAnsi } from './ui.js';

// How many lines to keep per channel. Chat is small and worth remembering for a whole
// session: 300 lines of clan is maybe an hour of talk, and costs almost nothing.
const KEEP = 300;

// Channels, in tab order. `test` runs against the ANSI-stripped line.
//
// Aardwolf writes the same channel more than one way -- a clan line is either
// "Agius (Sentinel) tells the CLAN: 'ola'" or "(Sentinel) CLAN: Killene waves" for the
// socials -- so each channel is a list of shapes rather than one regex.
const CHANNELS = [
  { key: 'tell',  label: 'Tells',  icon: '💬', tests: [
      /^\s*\w[\w'-]* tells you\b/i,
      /^\s*You tell \w/i,
      // Replies keep the conversation readable in one place.
      /^\s*\w[\w'-]* replies to you\b/i,
      /^\s*You reply to \w/i,
    ] },
  { key: 'group', label: 'Group',  icon: '👥', tests: [
      /\btells the group\b/i,
      /^\s*You tell the group\b/i,
      /^\s*\[Group\]/i,
      /\bgroup-tells\b/i,
    ] },
  { key: 'clan',  label: 'Clan',   icon: '🛡️', tests: [
      /\btells the CLAN\b/i,
      /^\s*\([A-Za-z' -]+\)\s*CLAN:/i,
      /^\s*CLAN:/i,
    ] },
  // Everything else people say out loud. Kept last so the specific channels win.
  { key: 'say',   label: 'Public', icon: '📢', tests: [
      /^\s*\w[\w'-]* (?:gossips|questions|answers|says|shouts|yells|chats|auctions)\b/i,
      /^\s*You (?:gossip|question|answer|say|shout|yell|chat)\b/i,
      /^\s*\w[\w'-]* \(\w+\) (?:gossips|chats)\b/i,
    ] },
];

// The lines that LOOK like conversation but are the game talking to itself. Quest and
// campaign NPCs use exactly the tell format -- "Questor tells you 'Congratulations'" --
// and a hundred of those would bury the two lines from an actual person, which is the
// whole problem this panel exists to solve. They still show in the main window.
const NOT_PEOPLE = /^\s*(?:Questor|The Questor|Quest Master|Questmaster)\b/i;

const log = new Map();          // key -> [{t, line}]
const unread = new Map();       // key -> count
let activeTab = 'clan';
let onBadge = null;             // called when the unread total changes

for(const c of CHANNELS){ log.set(c.key, []); unread.set(c.key, 0); }

function classify(clean){
  if(NOT_PEOPLE.test(clean)) return null;
  for(const c of CHANNELS){
    for(const re of c.tests){ if(re.test(clean)) return c.key; }
  }
  return null;
}

/**
 * Offer a line to the chat log. Called for EVERY line on its way to the screen, so it
 * has to be cheap and it must never throw -- a mistake here would take the main output
 * down with it, which is why the whole thing is wrapped.
 */
export function noteChatLine(rawLine){
  try {
    const clean = stripAnsi(String(rawLine || ''));
    if(!clean.trim()) return;
    const key = classify(clean);
    if(!key) return;
    const rows = log.get(key);
    rows.push({ t: Date.now(), line: rawLine });
    if(rows.length > KEEP) rows.shift();
    if(key !== activeTab || !isChatVisible()){
      unread.set(key, (unread.get(key) || 0) + 1);
      if(onBadge) onBadge(totalUnread());
    }
    if(isChatVisible()) renderChat();
  } catch(e){ /* never let the chat panel break the output pane */ }
}

export function totalUnread(){
  let n = 0;
  for(const c of CHANNELS) n += unread.get(c.key) || 0;
  return n;
}

export function onUnreadChange(fn){ onBadge = fn; }

function isChatVisible(){
  const el = document.getElementById('panel-chat');
  return !!(el && el.classList.contains('show'));
}

export function setChatTab(key){
  activeTab = key;
  unread.set(key, 0);
  if(onBadge) onBadge(totalUnread());
  renderChat();
}

function hhmm(t){
  const d = new Date(t);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

export function renderChat(){
  const tabs = document.getElementById('chat-tabs');
  const body = document.getElementById('chat-log');
  if(!tabs || !body) return;

  tabs.innerHTML = CHANNELS.map(c => {
    const n = unread.get(c.key) || 0;
    const on = c.key === activeTab;
    return '<button class="chat-tab'+(on?' on':'')+'" data-tab="'+c.key+'">'
      + c.icon + ' ' + c.label + (n ? ' <span class="chat-badge">'+n+'</span>' : '')
      + '</button>';
  }).join('');
  for(const b of tabs.querySelectorAll('.chat-tab')){
    b.addEventListener('click', ()=>setChatTab(b.getAttribute('data-tab')));
  }

  const rows = log.get(activeTab) || [];
  if(!rows.length){
    body.innerHTML = '<div class="chat-empty">Nothing on this channel yet.</div>';
    return;
  }
  // Oldest at the top, newest at the bottom, same as the main window -- and scrolled to
  // the bottom on open, because the newest line is the one being looked for.
  body.innerHTML = rows.map(r =>
    '<div class="chat-line"><span class="chat-time">'+hhmm(r.t)+'</span>'
    + ansiToHtml(r.line) + '</div>').join('');
  body.scrollTop = body.scrollHeight;
}

/** `/chat [clan|tell|group|say]` -- open the panel, optionally on a channel. */
export function openChat(arg){
  const want = String(arg || '').trim().toLowerCase();
  const hit = CHANNELS.find(c => c.key === want || c.label.toLowerCase() === want);
  if(hit) activeTab = hit.key;
  unread.set(activeTab, 0);
  if(onBadge) onBadge(totalUnread());
  return activeTab;
}

/**
 * Send from the panel, on whichever channel is being read.
 *
 * Without this the panel is read-only and answering a tell means closing it, finding the
 * name in the main window and typing `tell <name> ...` -- by which time the fight has
 * scrolled the name away. `reply` is what the game gives us for exactly this, so Tells
 * uses it rather than trying to parse a name out of the last line.
 */
const SEND_AS = {
  tell:  s => 'reply ' + s,
  group: s => 'gtell ' + s,
  clan:  s => 'clan ' + s,
  say:   s => 'say ' + s,
};

export function sendChat(){
  const box = document.getElementById('chat-input');
  if(!box) return;
  const msg = String(box.value || '').trim();
  if(!msg) return;
  box.value = '';
  const build = SEND_AS[activeTab] || SEND_AS.say;
  sendCmdRaw(build(msg));
}

export function clearChat(){
  for(const c of CHANNELS){ log.set(c.key, []); unread.set(c.key, 0); }
  if(onBadge) onBadge(0);
  renderChat();
}
