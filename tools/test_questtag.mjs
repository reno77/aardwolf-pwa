// Does the [QUEST] scan pick the copy `kill` will actually hit?
//
// Every case below is text the MUD really sent, captured from a live /xq run in
// Aardington Estate on a quest for "a swampy oil painting". Run: node
// tools/test_questtag.mjs
import { describesMob, findTagged, lookLanded, mobWordsFrom,
         roomContents } from '../pwa/js/questtag.js';

// whereKeywords('a swampy oil painting'), which is what quest.js passes in.
const WORDS = mobWordsFrom(['painting', 'swampy', 'oil']);

let failed = 0;
function check(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if(!ok){ failed++; console.log('FAIL ' + name + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else console.log('ok   ' + name);
}

// --- the room the tagged painting was standing in --------------------------
const LOOK = `{rdesc}
The hallway is lined with glass cases which have little of interest within.
Tapestries, made by the women of the house, adorn the walls.
{/rdesc}
[ Exits: (north) east (south) (west) ]
     A statuette from the Realms of the Firebird sits on a pedestal.
     Candelabra light the hallway against the night.
{roomchars}
(Flying) An oil painting of a swamp full of reeds is framed in gold. [QUEST]
A colourful tapestry of a boat on a lake is framed and hanging on the wall.
Lovingly hand drawn is a pencil sketch of a dark fortress.
{/roomchars}
[2880/2880hp 2359/2364mn 3068/3074mv 30qt 1308tnl] >
`;

{
  const r = findTagged(LOOK, WORDS, 'West wing');
  check('tag found', r.tagged, true);
  check('ordinal is 1, so the command is `kill oil`', r.ord, 1);
  check('one line reads as our mob', r.count, 1);
  check('floor objects are not in the mob list', r.lines.length, 3);
}

// --- the buffer that produced `kill 5.oil` -> "They aren't here." ----------
// Ten hunt probes ran immediately before the first live scan, so their replies
// were still in the buffer -- four of them naming oil paintings. The old cut took
// the FIRST exits line, which left all four in the list, and the real painting
// counted as the fifth.
const CONTAMINATED = `[ Exits: north east south west ]
You are certain that an oil painting is east from here.
An oil painting is here!
You are certain that a flying oil painting is east from here.
You are certain that a magical oil painting is east from here.
` + LOOK;

{
  const r = findTagged(CONTAMINATED, WORDS, 'West wing');
  check('stale hunt replies do not shift the ordinal', r.ord, 1);
  check('stale hunt replies are not counted as copies', r.count, 1);
}

// --- tags off: no {roomchars}, so the exits line is the only landmark -----
const NO_TAGS = `West wing
The hallway is lined with glass cases.
[ Exits: north east south west ]
A delightful oil painting hangs on the wall.
(Flying) An oil painting of a swamp full of reeds is framed in gold. [QUEST]
[2880/2880hp 2359/2364mn 3068/3074mv 30qt 1308tnl] >
`;

{
  const r = findTagged(NO_TAGS, WORDS, 'West wing');
  check('tags off: tag still found', r.tagged, true);
  check('tags off: the tagged copy is the second painting', r.ord, 2);
  check('tags off: the prompt is not a copy', r.count, 2);
}

// --- a room whose own NAME contains the mob's words -----------------------
// "Swamp Ape Enclosure" is the case that would make the real mob copy two or
// three and send `kill 3.ape` into "They aren't here."
const APE_ROOM = `Swamp Ape Enclosure
A swampy enclosure holds an ape or two.
[ Exits: north ]
A hulking ape beats its chest. [QUEST]
`;
check('the room title is not counted as a copy',
  findTagged(APE_ROOM, mobWordsFrom(['ape', 'swamp']), 'Swamp Ape Enclosure').ord, 1);

// --- no tag: nothing may be killed ---------------------------------------
const UNTAGGED = `{rdesc}
A quiet hallway.
{/rdesc}
[ Exits: north ]
{roomchars}
A delightful oil painting is framed in gold.
{/roomchars}
[2880/2880hp 2359/2364mn 3068/3074mv 30qt 1308tnl] >
`;
{
  const r = findTagged(UNTAGGED, WORDS, 'West wing');
  check('untagged room reports no tag', r.tagged, false);
  check('untagged room still recognises the painting', r.count, 1);
}

// --- the buffer the old scan settled on in the NEXT room ------------------
// "They aren't here." plus a prompt, with the look reply not yet arrived. The old
// code settled on this and called it a room with no tag; worse, its predecessor
// killed on it. lookLanded is what keeps the scan waiting.
check('a reply that has not arrived is not a room',
  lookLanded(`They aren't here.\n[2880/2880hp 2359/2364mn 3068/3074mv 30qt 1308tnl] >\n`), false);
check('an exits line means the reply landed', lookLanded(LOOK), true);

// --- renderings other than [QUEST] ---------------------------------------
for(const tag of ['[QUEST]', '[Quest]', '[quest]', '(Quest)', '[Quest Target]']){
  const room = `[ Exits: north ]\nAn oil painting hangs here. ${tag}\n`;
  check('tag rendering ' + tag, findTagged(room, WORDS, '').ord, 1);
}

// --- describesMob: room lines are long descriptions, word order is not the name's ---
// Captured in Svrogan's Logging Camp, where four of a campaign's targets answered to
// `ironwood` and the in-order test rejected the one standing in front of the character.
{
  const line = 'Swaying gently, this massive Ironwood is creaking under its own weight.';
  const faint = '(Flying) Gentle swaying from this Ironwood produces the faintest of sounds.';
  check('a creaking Ironwood is described by the creaking line',
    describesMob('A creaking Ironwood', line), true);
  check('...even though ironwood comes first in that sentence',
    /Ironwood is creaking/.test(line), true);
  check('the faint line is NOT the creaking Ironwood',
    describesMob('A creaking Ironwood', faint), false);
  check('a sentinel needs the word sentinel',
    describesMob('A creaking Ironwood sentinel', line), false);
  check('an elder needs the word elder',
    describesMob('A whispering Ironwood elder', line), false);
  // The ordinal that comes out of a real room: three ironwood lines, the target is the
  // second, so the command is `kill 2.ironwood`.
  const room = '[ Exits: north ]\n{roomchars}\n' + faint + '\n' + line + '\n' + line + '\n{/roomchars}\n';
  const lines = roomContents(room, 'Wandering through the ironwoods');
  const counted = lines.filter(l => l.toLowerCase().includes('ironwood'));
  check('three things answer to ironwood', counted.length, 3);
  check('the creaking one is number 2',
    counted.findIndex(l => describesMob('A creaking Ironwood', l)) + 1, 2);
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
process.exit(failed ? 1 : 0);
