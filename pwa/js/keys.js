// keys.js -- reading Gaardian's note about how to get past a locked exit.
//
// 882 exits across 132 areas carry a note. The client only ever did one thing
// with them: `tryBuyKeyThen`, which looks for a shop. Purchases are 24 of the
// 882. The overwhelming majority say the key is carried by a mob, in a dozen
// different phrasings:
//
//     on rock bandit                                (50 exits, bare form)
//     The key can be found on an ogre guard.
//     The key is held by The Butcher.
//     Brandt has this keyring.
//     A large, fat rat is carrying this key.
//     The key is in Rydra's inventory.
//     Kill the Jailor here to retrieve the jail key.
//
// So the note was being read for the rarest case and ignored for the common one,
// which is why a locked door reported nothing useful and the walker just routed
// around it or gave up.
//
// No imports on purpose: this is pure text, and keeping it dependency-free means
// it can be run against all 882 notes outside a browser.

/** Gaardian stores the note as HTML. */
export function cleanNote(html){
  if(!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ordered most specific first: "kill X to get the key" must not be read as a
// bare "on X", and a purchase must not be read as a mob.
const MOB = [
  /^kill\s+(?:the\s+|any\s+of\s+the\s+|any\s+)?(.+?)\s+(?:here\s+)?(?:to|for)\b/i,
  /\bkill\s+(?:the\s+|any\s+of\s+the\s+|any\s+)?(.+?)\s+(?:to get|for)\s/i,
  /\bkeys?\s+is\s+in\s+([\w' -]+?)'s\s+inventory/i,
  /\b(?:found|carried)\s+(?:in|on)\s+(?:a\s+|an\s+|the\s+)?(.+?)'s\s+inventory/i,
  /\b(?:on|by)\s+'([^']+)'/i,
  /\bkeys?\s+(?:can be\s+|is\s+)?(?:found\s+|held\s+)?(?:on|by)\s+(.+?)\s*[.,]?$/i,
  /\b(?:key|keyring|keys|card|pass|band)\s+is\s+(?:on|held by|carried by)\s+(.+?)\s*[.,]?$/i,
  /^(.+?)\s+(?:has|holds)\s+th(?:is|e)\s+(?:key|keyring|keys)\b/i,
  /^(.+?)\s+is\s+carrying\s+th(?:is|e)\s+(?:key|keyring|keys)\b/i,
  /^(?:it(?:'s| is)?\s+)?on\s+(?:the\s+)?(.+?)\s*[.,]?$/i,
  // "Found on an Imperial city guard who patrols Finian Lane." -- the bare shape, with
  // no "key" in the sentence for the patterns above to anchor on. Eight of the 310 key
  // notes are written this way, and the Imperial Nation one held up a campaign target:
  // the map named the mob, the room we were standing in, and the client read it as
  // "unknown" and gave up on the door.
  /^found\s+(?:on|with)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s*[.,]?$/i,
];
// "The key is in Rydra's inventory.", "found in the ogre guard's inventory" -- the
// possessive is the tell, and it means a creature however the sentence is built.
const POSSESSIVE = [
  /\bkeys?\s+is\s+in\s+([\w' -]+?)'s\s+inventory/i,
  /\b(?:found|carried|held)\s+(?:in|on)\s+(?:a\s+|an\s+|the\s+)?([\w' -]+?)'s\s+inventory/i,
  /\bin\s+([\w' -]+?)'s\s+inventory/i,
];
const BUY = [
  /\bpurchased\s+from\s+([\w' -]+?)\s+for\s+([\d,]+)\s+gold/i,
  /\bbuy\s+([\w-]+)/i,
  /\b(?:bought|sold)\s+(?:from|by)\s+([\w' -]+)/i,
];
// "The key is inside a large mahogany desk." -- not carried by anyone and not for
// sale, so neither of the branches above applies. The Aardington skeleton key is
// one of these, and the helper walked to the right room, sent `buy key`, announced
// "bought a skeleton key" without checking, walked back, and hit the same locked
// door. Opening the container and taking the key is a different action, so it is a
// different kind.
const CONTAINER = [
  /\bkeys?\s+is\s+(?:inside|in)\s+(?:a\s+|an\s+|the\s+)?([\w' -]+?)\s*[.,]?$/i,
  /\b(?:found|hidden)\s+(?:inside|in)\s+(?:a\s+|an\s+|the\s+)?([\w' -]+?)\s*[.,]?$/i,
  /\bopen\s+the\s+([\w' -]+?)\b[^.]*\bis inside\b/i,
];
// Notes that describe a quest or give no lead at all. Worth telling the player
// apart from "we could not read this", because the answer is different.
const QUEST = [/^a\/?q\b/i, /\barea quest\b/i, /\bquest\b[^.]*\bobtain\b/i];

// Prose that trails a mob name: ", who wanders around near the magic shop",
// " or Mr. Spade in the Manager's Office", " in the Manager's Office".
//
// The comma is optional and a parenthesis counts too. "an Imperial city guard who
// patrols Finian Lane" has neither a comma nor a "the", so the whole sentence survived
// as the mob name and the keyword search went looking for a creature called that.
const TRAIL = /,?\s*\b(?:who|which|that)\b|\s+or\s+|\s+in\s+the\s+|\s+within\s+|\s*\(/i;

// Where the note says that mob is. "an Imperial city guard who patrols Finian Lane"
// is not one guard among many, it is THE guard, and the area has several: the errand
// killed one in Before the Imperial Castle, found no key on it, and stopped. `where`
// lists every sighting, so naming the right room is the whole difference between one
// kill and a wrong one.
const MOB_ROOM = /\b(?:patrols|patrolling|wanders?(?:\s+around)?(?:\s+in)?|stands?)\s+(?:in|around|near|the)?\s*([A-Z][\w' -]{3,40}?)\s*[.,)]/;

function mobRoom(note){
  const m = String(note || '').match(MOB_ROOM);
  return m ? m[1].trim() : null;
}

function tidyMob(raw){
  let mob = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  mob = mob.split(TRAIL)[0].trim().replace(/[.,;:]+$/, '');
  return mob;
}

/**
 * Read a key note.
 *
 * Returns {kind, note, mob?, who?, price?} where kind is one of:
 *   'mob'     -- a mob is carrying it; `mob` is the name to look for
 *   'buy'     -- purchasable; `who` is the shop/keeper, `price` if stated
 *   'quest'   -- an area quest reward; nothing to automate
 *   'unknown' -- there is a note but we could not read it (still worth showing)
 *   'none'    -- no note at all
 */
export function parseKeySource(rawNote){
  const note = cleanNote(rawNote);
  if(!note) return {kind: 'none', note: ''};
  for(const re of QUEST) if(re.test(note)) return {kind: 'quest', note};
  // A POSSESSIVE inventory names a creature, and it has to be tested before the
  // container patterns because "is in ..." matches both. Imperial Nation's small blue
  // key is "in Jereck's inventory": read as a container, the client looked for a
  // container called "Jereck's inventory" in the room, did not find one, and gave up on
  // a key that is carried by a mob it knows the name of.
  for(const re of POSSESSIVE){
    const m = note.match(re);
    if(!m) continue;
    const mob = tidyMob(m[1]);
    if(mob.length > 2 && mob.length < 60) return {kind: 'mob', note, mob};
  }
  // Container before mob otherwise: "The key is inside a large mahogany desk" must not
  // be read as a mob called "a large mahogany desk".
  for(const re of CONTAINER){
    const m = note.match(re);
    if(m){
      const box = String(m[1] || '').trim().replace(/[.,;:]+$/, '');
      if(box.length > 2 && box.length < 50) return {kind: 'container', note, container: box};
    }
  }
  for(const re of BUY){
    const m = note.match(re);
    if(m) return {kind: 'buy', note, who: (m[1] || '').trim(), price: m[2] || null};
  }
  for(const re of MOB){
    const m = note.match(re);
    if(!m) continue;
    const mob = tidyMob(m[1]);
    // Guard against fragments: too short to be a name, or a container rather
    // than a creature.
    if(mob.length > 2 && mob.length < 60 && !/^(the\s+)?(chest|ground|floor|room)\b/i.test(mob)){
      return {kind: 'mob', note, mob, room: mobRoom(note)};
    }
  }
  return {kind: 'unknown', note};
}
