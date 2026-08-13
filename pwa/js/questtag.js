// questtag.js -- read a room's mob list and find the [QUEST]-tagged copy.
//
// Split out of quest.js for one reason: this is the part that decides what to
// attack, it is pure text handling, and every mistake it makes costs a quest. On
// its own it imports nothing, so tools/test_questtag.mjs can run it under Node
// against output captured from the live game -- which is how the ordinal bug
// below was proved fixed rather than argued about.
//
// The real thing, from Aardington Estate, live:
//
//   [ Exits: (north) east (south) (west) ]
//        A statuette from the Realms of the Firebird sits on a pedestal.
//        Candelabra light the hallway against the night.
//   {roomchars}
//   (Flying) An oil painting of a swamp full of reeds is framed in gold. [QUEST]
//   A colourful tapestry of a boat on a lake is framed and hanging on the wall.
//   Lovingly hand drawn is a pencil sketch of a dark fortress.
//   {/roomchars}
//
// Three things worth noting in that. The tag is [QUEST], upper case. The line is
// a long description -- "a swampy oil painting" appears nowhere in it -- so
// matching on the mob's name as written is hopeless and matching on its WORDS is
// not. And the mob list is bracketed by {roomchars}, which is exactly the list
// `kill`'s ordinals count: floor objects sit above it, players below.

// Both bracket styles and an optional word after "quest": the rendering is the
// game's to choose, and a missed tag costs a quest.
export const QUEST_TAG = /[\[(<]\s*quest(?:\s+(?:target|mob))?\s*[\])>]/i;

// Aardwolf prints this between the description and the contents, tags or no tags.
export const EXITS_LINE = /^\[?\s*(?:obvious\s+)?exits?\s*:/i;

const PROMPT_LINE = /^\[?\d+\/\d+hp/;

/** Has the reply to `look` actually arrived, or is this still the old buffer? */
export function lookLanded(buf){
  if(/\{\/roomchars\}/.test(String(buf))) return true;
  return String(buf).split(/\r?\n/).some(l => EXITS_LINE.test(l.trim()));
}

/**
 * The lines that are things standing in the room.
 *
 * With tags on this is exact. Without them, cut at the LAST exits line: the room's
 * own name and description sit above it, and counting those is not hypothetical --
 * a quest mob in "Swamp Ape Enclosure" stands in a room whose title says "ape".
 * Last, not first, because a scan can be carrying an earlier room in its buffer.
 */
export function roomContents(buf, hereName){
  const s = String(buf || '');
  const blocks = s.match(/\{roomchars\}([\s\S]*?)\{\/roomchars\}/g);
  if(blocks && blocks.length){
    return blocks[blocks.length - 1]
      .replace(/\{\/?roomchars\}/g, '')
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  const all = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let cut = -1;
  for(let i = 0; i < all.length; i++) if(EXITS_LINE.test(all[i])) cut = i;
  const lines = cut >= 0 ? all.slice(cut + 1) : all.slice(1);
  const here = String(hereName || '').toLowerCase();
  return lines.filter(l => l.toLowerCase() !== here && !PROMPT_LINE.test(l)
                           && !/^\{\/?\w+\}$/.test(l));
}

/** Does this line read like the mob we want? */
export function mentionsMob(line, words){
  const l = String(line).toLowerCase();
  return (words || []).some(w => w && l.includes(w));
}

/**
 * Where the tagged copy is, counted the way `kill` counts.
 *
 * `ord` is its position among the lines that read like our mob, which is the
 * ordinal `kill <n>.<kw>` wants. `ord` 0 with `tagged` true means the tag is in
 * the room but not on a line naming the mob -- its long description simply does
 * not repeat its name, which is common -- and the plain keyword is then the right
 * thing to swing at.
 */
export function findTagged(buf, words, hereName){
  const lines = roomContents(buf, hereName);
  const mine = lines.filter(l => mentionsMob(l, words));
  const tagged = lines.some(l => QUEST_TAG.test(l));
  const ord = mine.findIndex(l => QUEST_TAG.test(l)) + 1;
  return { lines, mine, tagged, ord, count: mine.length };
}

/** The words from a mob's name worth looking for in a long description. */
export function mobWordsFrom(keywords){
  return (keywords || []).filter(w => w && w.length >= 3).slice(0, 4);
}

const NAME_STOP = new Set(['a','an','the','of','and','in','on','at','with','to','from']);

/**
 * Does this room line describe `mobName`?
 *
 * All the name's significant words, in ANY order. Order is the trap: snd.js's mobMatches
 * requires them in sequence, which is right for a `where` reply (a real name) and wrong
 * here, because these are long descriptions. Live, in Svrogan's Logging Camp:
 *
 *   target: "A creaking Ironwood"
 *   line:   "Swaying gently, this massive Ironwood is creaking under its own weight."
 *
 * -- ironwood comes before creaking, so the in-order test rejected the very mob it was
 * standing in front of, four times over, and fell back to the plain keyword that had
 * already killed the wrong tree.
 */
export function describesMob(mobName, line){
  const want = String(mobName || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const sig = want.filter(w => !NAME_STOP.has(w) && w.length > 1);
  if(!sig.length) return false;
  const hay = String(line || '').toLowerCase();
  return sig.every(w => hay.includes(w));
}
