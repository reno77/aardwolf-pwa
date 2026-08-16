// board.js -- read and write the forum boards without fighting the scroll.
//
// Aardwolf's notes are a genuinely good forum bolted to a command line, and on a phone
// that is the problem: `note list` prints a 78-column table that wraps into soup, reading
// a post means finding it again in the backlog, and writing one drops you into a modal
// line editor where a stray alias or a trigger firing mid-compose ends up IN the post.
// (The game says so itself: "Remember to turn off aliases in your client to avoid spam
// in your post!")
//
// So this parses the three things the game already prints -- the board table, the post
// table, and a rendered note -- into a panel, and drives the editor from a form.

import { sendCmdRaw } from './net.js';
import { appendOutput, stripAnsi } from './ui.js';

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------
//
// Every one of these is a fixed-width table with `|` separators, so the columns are
// reliable -- but the ROWS arrive interleaved with whatever else the MUD is saying,
// which is the same trap that made the `where` parser eat channel spam. Each row is
// therefore matched on its full shape rather than on "contains a pipe".

// | 1 | Announce | 16 | Announcements from Immortals |
const BOARD_ROW = /^\|\s*(\d+)\s*\|\s*([A-Za-z][\w' -]*?)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|$/;
// | 1|03 Aug 13:39|*Ailat | Blowtorch Mud Client seems ... | 17|
const POST_ROW  = /^\|\s*(\d+)\|\s*([^|]{6,20}?)\s*\|\s*(\*?)([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(\d+)\|$/;

export let boards = [];        // [{num, name, unread, desc}]
export let posts  = [];        // [{num, when, unread, author, subject, size}]
export let currentBoard = '';
let awaitingList = false;   // true between `note list` and its final row
export let openNote = null;    // {num, from, forum, to, date, body[]}

let onChange = null;
export function onBoardChange(fn){ onChange = fn; }
function changed(){ if(onChange) onChange(); }

/**
 * Feed ONE finished line here -- ui.js calls this from emitLine.
 *
 * Not from the raw socket text: these are fixed-width table rows, and the MUD arrives in
 * arbitrary TCP-sized chunks that split a row down the middle. Parsing chunks matched
 * nothing at all on the first try, because "| 1 | Announce | 16 |..." had been cut in two.
 * emitLine is where whole lines exist, which is why the chat panel taps it too.
 */
export function noteBoardLine(rawLine){
  try { boardLine(rawLine); } catch(e){ /* never let this break the output pane */ }
}

function boardLine(text){
  const clean = stripAnsi(String(text || ''));
  let touched = false;

  for(const raw of clean.split(/\r?\n/)){
    const line = raw.replace(/\s+$/, '');

    // Aardwolf pages long output and WAITS: "[ (Q)uit, (B)ack, (R)efresh, (L)ast, (A)ll ]".
    // Everything typed while that prompt is up is eaten by the pager, so a `note list` on
    // a busy forum silently swallowed the next few commands and left the session wedged
    // in a prompt -- a quest request and a campaign request went into it and vanished.
    // Answer it with (A)ll, but ONLY while we are the ones waiting on a listing, so this
    // never hijacks a pager the player opened themselves.
    if(awaitingList && /\(Q\)uit.*\(A\)ll/i.test(line)){
      sendCmdRaw('a');
      return touched;
    }
    const b = line.match(BOARD_ROW);
    if(b && !/^Forum$/i.test(b[2])){
      const num = parseInt(b[1], 10);
      const row = {num, name: b[2], unread: parseInt(b[3], 10) || 0, desc: b[4]};
      const at = boards.findIndex(x => x.num === num);
      if(at >= 0) boards[at] = row; else boards.push(row);
      touched = true;
      continue;
    }

    const p = line.match(POST_ROW);
    if(p && !/^Post#/i.test(p[1])){
      // The `*` before an author marks a post you have not read.
      const num = parseInt(p[1], 10);
      const row = {num, when: p[2], unread: p[3] === '*', author: p[4],
                   subject: p[5], size: parseInt(p[6], 10) || 0};
      const at = posts.findIndex(x => x.num === num);
      if(at >= 0) posts[at] = row; else posts.push(row);
      touched = true;
      continue;
    }

    // "Posts in the Misc forum :" -- the list that follows belongs to a new board, so
    // the old one's posts have to go or the panel shows two boards mixed together.
    const which = line.match(/^Posts in the (.+?) forum/i);
    if(which){
      if(currentBoard.toLowerCase() !== which[1].toLowerCase()) posts = [];
      currentBoard = which[1];
      touched = true;
      continue;
    }
  }

  if(/^\[\d+\/\d+hp/.test(clean)) awaitingList = false;
  if(parseNoteBody(clean)) touched = true;
  if(touched){ posts.sort((a,b)=>a.num-b.num); boards.sort((a,b)=>a.num-b.num); changed(); }
}

// A rendered note, which arrives as a header block between rows of tildes and then body
// lines each prefixed with "| ". Collected across chunks because a long note does not
// arrive in one piece.
let reading = null;

function parseNoteBody(clean){
  let touched = false;
  for(const raw of clean.split(/\r?\n/)){
    const line = raw.replace(/\s+$/, '');

    const from = line.match(/^From\s*:\s*([^:]+?)\s*:\s*(.*)$/);
    if(from){ reading = {from: from[1], subject: from[2], body: []}; touched = true; continue; }
    if(!reading) continue;

    const forum = line.match(/^Forum\s*:\s*(.+?)\s*-\s*#(\d+)/);
    if(forum){ reading.forum = forum[1]; reading.num = parseInt(forum[2], 10); continue; }
    const to = line.match(/^To\s*:\s*(.+)$/);
    if(to){ reading.to = to[1]; continue; }
    const date = line.match(/^Date\s*:\s*(.+)$/);
    if(date){ reading.date = date[1]; continue; }

    // Body lines are prefixed with a bar. A bare "|" is a blank line in the post.
    if(/^\|/.test(line)){ reading.body.push(line.replace(/^\|\s?/, '')); touched = true; continue; }

    // The prompt ends the note.
    if(/^\[\d+\/\d+hp/.test(line) && reading.body.length){
      openNote = reading; reading = null; touched = true;
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

// `board` alone lists only forums that currently have UNREAD notes, so a board you are
// caught up on silently disappears from the panel -- Misc vanished the moment its one
// note was read, leaving no way to select it. `board all` lists every subscribed forum.
export function refreshBoards(){ sendCmdRaw('board all'); }

export function openBoard(name){
  posts = [];
  currentBoard = name;
  sendCmdRaw('board ' + name);
  awaitingList = true;
  setTimeout(()=>sendCmdRaw('note list'), 700);
}

export function readNote(num){
  openNote = null;
  // `peek` rather than `read`: opening a note in the panel should not silently move the
  // last-read pointer, because the pointer is what `note` and `note unread` work from and
  // clicking around a list would quietly mark the board caught up.
  sendCmdRaw('note peek ' + num);
}

export function catchupBoard(){ sendCmdRaw('note catchup'); setTimeout(refreshBoards, 700); }

/**
 * Post a note, driving the game's modal editor from the form.
 *
 * The editor is line-based and stateful: `note write <to>` prompts for a subject, then
 * every line typed becomes note text until `.p` posts it. Two consequences shape this:
 *
 *  - Lines go out RAW. sendCmd would expand aliases, and the game explicitly warns that
 *    an alias firing mid-compose ends up in the post.
 *  - The lines are paced. Sending the whole body in one burst raced the prompt and the
 *    first line was eaten as the subject.
 *
 * `.p` is only sent after the body, and nothing here can post an empty note: an accidental
 * empty send would still create a post, which is public and cannot be un-posted by anyone
 * but the author.
 */
export function postNote(board, to, subject, body){
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  if(!String(to || '').trim())      { appendOutput('[board] a note needs a "To" -- a player name, or "all".\n','error'); return false; }
  if(!String(subject || '').trim()) { appendOutput('[board] a note needs a subject.\n','error'); return false; }
  if(!lines.some(l => l.trim()))    { appendOutput('[board] the note is empty -- nothing posted.\n','error'); return false; }

  appendOutput('[board] posting to ' + board + ' -- ' + lines.length + ' line(s).\n','quest');
  let step = 0;
  const at = ms => step += ms;
  if(board) setTimeout(()=>sendCmdRaw('board ' + board), at(0));
  setTimeout(()=>sendCmdRaw('note write ' + to), at(700));
  setTimeout(()=>sendCmdRaw(subject), at(900));
  for(const line of lines){
    // A blank line in the editor is meaningful, but sendCmdRaw of "" sends nothing --
    // so a space keeps the paragraph break.
    const out = line.length ? line : ' ';
    setTimeout(()=>sendCmdRaw(out), at(450));
  }
  setTimeout(()=>{
    sendCmdRaw('.p');
    appendOutput('[board] posted.\n','quest');
    setTimeout(refreshBoards, 1200);
  }, at(700));
  return true;
}

/** Abandon a note that is mid-compose. */
export function cancelNote(){ sendCmdRaw('.q'); }

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export function renderBoard(){
  const tabs = document.getElementById('board-tabs');
  const body = document.getElementById('board-body');
  if(!tabs || !body) return;

  tabs.innerHTML = boards.length
    ? boards.map(b =>
        '<button class="board-tab'+(b.name.toLowerCase()===currentBoard.toLowerCase()?' on':'')
        + '" data-board="'+esc(b.name)+'" title="'+esc(b.desc)+'">'
        + esc(b.name) + (b.unread ? ' <span class="board-badge">'+b.unread+'</span>' : '')
        + '</button>').join('')
    : '<span class="board-empty">Tap ⟳ to load the forum list.</span>';
  for(const el of tabs.querySelectorAll('.board-tab')){
    el.addEventListener('click', ()=>openBoard(el.getAttribute('data-board')));
  }

  if(openNote){
    body.innerHTML =
      '<div class="note-head"><b>'+esc(openNote.subject)+'</b><br>'
      + '<span class="note-meta">from '+esc(openNote.from)
      + ' &middot; to '+esc(openNote.to||'?')
      + ' &middot; '+esc(openNote.date||'')
      + ' &middot; '+esc(openNote.forum||'')+' #'+esc(openNote.num)+'</span></div>'
      + '<div class="note-body">'+esc(openNote.body.join('\n'))+'</div>'
      + '<button class="board-back" id="note-back">← back to the list</button>';
    const back = document.getElementById('note-back');
    if(back) back.addEventListener('click', ()=>{ openNote = null; renderBoard(); });
    return;
  }

  if(!posts.length){
    body.innerHTML = '<div class="board-empty">'
      + (currentBoard ? 'No posts listed for '+esc(currentBoard)+' yet.' : 'Pick a forum above.')
      + '</div>';
    return;
  }
  body.innerHTML = posts.map(p =>
    '<div class="post-row'+(p.unread?' unread':'')+'" data-num="'+p.num+'">'
    + '<span class="post-num">'+p.num+'</span>'
    + '<span class="post-subj">'+esc(p.subject)+'</span>'
    + '<span class="post-meta">'+esc(p.author)+' &middot; '+esc(p.when)+'</span>'
    + '</div>').join('');
  for(const el of body.querySelectorAll('.post-row')){
    el.addEventListener('click', ()=>readNote(parseInt(el.getAttribute('data-num'),10)));
  }
}

/** `/board [name]` -- open the panel, optionally on a forum. */
export function openBoardPanel(arg){
  const want = String(arg || '').trim();
  if(want) openBoard(want);
  else if(!boards.length) refreshBoards();
  else if(currentBoard) sendCmdRaw('note list');
}

/** Called by the panel's Post button. */
export function submitNote(){
  const to   = (document.getElementById('note-to')    || {}).value || '';
  const subj = (document.getElementById('note-subj')  || {}).value || '';
  const text = (document.getElementById('note-text')  || {}).value || '';
  if(postNote(currentBoard, to, subj, text)){
    const t = document.getElementById('note-text'); if(t) t.value = '';
    const s = document.getElementById('note-subj'); if(s) s.value = '';
    toggleCompose(false);
  }
}

export function toggleCompose(on){
  const el = document.getElementById('board-compose');
  if(!el) return;
  const show = (on === undefined) ? el.style.display === 'none' : !!on;
  el.style.display = show ? 'block' : 'none';
}
