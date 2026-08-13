// Does every module actually have the names it uses?
//
// check_wiring.mjs verifies that an IMPORT names something the other module exports. This
// asks the opposite question: a module that CALLS a function it never imported. Splitting
// snd.js exposed exactly that -- it kept calling tryGetKeyThen after the function moved to
// keyfetch.js, which is valid syntax, resolves nowhere, and throws only when that branch
// runs. Nothing else in the toolchain notices.
//
// Deliberately crude: collect the identifiers each file declares or imports, then look for
// call sites `name(` whose name is declared nowhere. Crude is fine -- a false positive is a
// name to double-check, and the alternative was finding these in play.
import { readdirSync, readFileSync } from 'node:fs';

const dir = 'D:/projects/aardwolf-pwa/pwa/js';
const files = readdirSync(dir).filter(f => f.endsWith('.js'));

// Names the language and browser provide. Not exhaustive; extend when something legitimate
// shows up rather than loosening the check.
const GLOBALS = new Set(['true','false','null','undefined','NaN','Infinity','self','globalThis',
  'let','const','var','break','continue','else','while','arguments',
  'if','for','switch','catch','return','typeof','function',
  'setTimeout','setInterval','clearTimeout','clearInterval','parseInt','parseFloat','String',
  'Number','Boolean','Array','Object','JSON','Math','Date','Set','Map','RegExp','Error','Promise',
  'console','document','window','localStorage','navigator','fetch','alert','confirm','require',
  'isNaN','encodeURIComponent','decodeURIComponent','btoa','atob','structuredClone','Worker',
  'WebSocket','Blob','URL','performance','FileReader','Uint8Array','ArrayBuffer','TextDecoder',
  'requestAnimationFrame','queueMicrotask','initSqlJs','location','indexedDB','import','super','this','await','new','delete','void',
  'do','else','try','finally','throw','yield','case','default','in','of','instanceof']);

/**
 * Code only: no comments, no string literals.
 *
 * Without this the scan reads prose and SQL as source and reports `unattended()`,
 * `COALESCE()` and `VALUES()` as missing functions -- forty lines of noise that would train
 * anyone reading it to ignore the whole check.
 */
function codeOnly(src){
  // STRINGS FIRST, then comments. The other order lets a `//` or `/*` inside a string
  // literal start a comment that runs to the end of the line -- or to the next `*/`
  // hundreds of lines later, swallowing real declarations. That is not hypothetical: it hid
  // `function cleanKeyDesc` in db.js and a whole hook object in quest.js, and the check then
  // reported them as missing functions.
  return src
    .replace(/`(?:\\.|[^`\\])*`/g, '``')    // template literals
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    // Block comments become the same NUMBER OF LINES, not one space: collapsing a
    // twelve-line docstring joins the code above it to the code below, and every
    // line-anchored pattern below then misses the declaration that follows. That is what hid
    // quest.js's `tagGate(...)` and db.js's `function cleanKeyDesc` from this very check.
    .replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) || []).length))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // line comments, but not the // in a URL
    // Regex literals, which are full of prose in this codebase: /you (?:hold|wield)/ read as
    // a call to you(). Only where a regex can legally start, so division survives.
    .replace(/([=(,\[:!&|?]|\breturn|\bcase)(\s*)\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g,
             (m, pre, ws) => pre + ws + '/RE/');
}

// Known good, and why. Both are declared in the same file, and both are hidden from the
// scan by the same limitation: stripping strings with regexes cannot tell an apostrophe in
// a comment ("don't") from the start of a string literal, so the "string" runs on and eats
// the declaration that follows. Fixing that properly needs a tokeniser, which is more
// machinery than this check is worth -- so the two casualties are named here instead, and
// anything NEW that shows up is a real finding.
const KNOWN_GOOD = new Set(['db.js:cleanKeyDesc', 'transport.js:NativeTransport',
  // Short locals the crude collector cannot see: a labelled loop and a one-letter
  // parameter. Named rather than loosened, so the check stays sharp for real finds.
  'dinv.js:label', 'roomid.js:t']);

let bad = 0;
for(const f of files){
  const src = codeOnly(readFileSync(dir + '/' + f, 'utf8'));
  const declared = new Set([...GLOBALS]);
  const add = (re, group = 1) => {
    for(const m of src.matchAll(re)) if(m[group]) declared.add(m[group]);
  };
  add(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g);
  add(/(?:export\s+)?(?:const|let|var)\s+(\w+)/g);
  add(/class\s+(\w+)/g);                                     // class declarations
  add(/(\w+)\s*(?::|=)\s*(?:async\s*)?(?:function|\()/g);      // object methods, arrow consts
  // Shorthand methods, in object literals and classes: `tagGate(t, proceed){ ... }` and
  // `close(){ ... }`. Their definition IS a `name(` and the scan below cannot tell it from a
  // call, so quest.js's hook object and transport.js's classes read as six missing
  // functions. Anything followed by `){` or `) {` at the start of a line is a definition.
  // The parameter list must NOT be allowed to cross lines: with [^)]* the line
  // `setQuestHooks({` matched as one definition whose parameters ran on for seven lines and
  // swallowed the `tagGate(...)` inside it, so the hook itself read as undeclared.
  add(/^[ \t]*(?:static\s+|async\s+|get\s+|set\s+)?(\w+)\s*\([^)\n]*\)\s*\{/gm);
  add(/\.\s*(\w+)\s*\(/g);                                     // method calls: not our problem
  add(/\bcatch\s*\(\s*(\w+)/g);
  // A single-parameter arrow with no parentheses: `const shrink = hits => ...`.
  add(/(?:^|[=(,:]|=>)\s*([a-zA-Z_$][\w$]*)\s*=>/g);
  // Array destructuring, including in a for-of head: `for(const [fArea, fLocal] of froms)`.
  for(const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/g)){
    for(const part of m[1].split(',')){
      const n = part.trim().replace(/^\.\.\./, '').replace(/[\[\]]/g, '');
      if(n) declared.add(n);
    }
  }
  add(/(?:\(|,|\{)\s*(\w+)\s*(?=[,)}=])/g);                    // parameters and destructuring
  for(const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)){
    for(const part of m[1].split(',')){
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if(name) declared.add(name);
    }
  }
  for(const m of src.matchAll(/import\s+(\w+)\s+from/g)) declared.add(m[1]);

  // VARIABLES too, not just calls. The db.js split moved `const importedAreas` into
  // roomid.js and left isAreaImported behind in db.js still reading it: a ReferenceError on
  // every room.info, swallowed by the WebSocket handler's try/catch, so the client's idea of
  // which room it was in simply froze -- and every route, area check and portal test after
  // that was computed against a room the character had long since left. It looked like a
  // pathfinding bug for an hour. This check only looked at `name(`, so it saw nothing.
  //
  // Only module-level SHOUTY_CASE and camelCase reads that appear in an obvious value
  // position; deliberately narrow, because the alternative is drowning in locals.
  const seen = new Set();
  for(const m of src.matchAll(/(?:^|[({[=,;]|return|&&|\|\|)\s*(?<![.\w$])([a-zA-Z_$][\w$]*)\s*(?=[.)\],;]|\s(?:instanceof|in))/g)){
    const name = m[1];
    if(declared.has(name) || seen.has(name) || KNOWN_GOOD.has(f + ':' + name)) continue;
    seen.add(name);
    console.log(`UNRESOLVED NAME: ${f} reads ${name} but never declares or imports it`);
    bad++;
  }
  for(const m of src.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)){
    const name = m[1];
    if(declared.has(name) || seen.has(name) || KNOWN_GOOD.has(f + ':' + name)) continue;
    seen.add(name);
    console.log(`UNRESOLVED CALL: ${f} calls ${name}() but never declares or imports it`);
    bad++;
  }
}
console.log(bad ? `\n${bad} unresolved call(s)` : `\n${files.length} modules: every function called is declared or imported`);
process.exit(bad ? 1 : 0);
