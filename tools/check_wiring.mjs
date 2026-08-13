// Three checks the client had no way of catching, all of which bit in practice:
//   1. an import naming something the module does not export  (would throw)
//   2. an exported output parser that nothing ever calls       (silently dead)
//   3. a control character in the source                       (silently dead)
//   4. a module that is not valid ES module syntax             (nothing loads at all)
//
// (3) needs explaining. Editing a file through a shell heredoc turns `\b` in a
// regex into a literal backspace byte, so `/\bwear\s+wpn\s+2\b/` ships as
// `/<BS>wear\s+wpn\s+2<BS>/` and can never match anything. It is valid
// JavaScript, `node --check` passes, and the regex is simply always false. Two
// were found in the tree this way -- one in snd.js that had never once repaired
// the recall sequence it was written for, and one nearly shipped in db.js.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = 'D:/projects/aardwolf-pwa/pwa/js';
const files = readdirSync(dir).filter(f => f.endsWith('.js'));
const src = Object.fromEntries(files.map(f => [f, readFileSync(dir + '/' + f, 'utf8')]));

const exported = {};
for(const [f, s] of Object.entries(src)){
  exported[f] = new Set([
    ...[...s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]),
    ...[...s.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)].map(m => m[1]),
  ]);
}

let bad = 0;

for(const [f, s] of Object.entries(src)){
  for(const m of s.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([\w.]+?)(?:\.js)?['"]/g)){
    const from = m[2].endsWith('.js') ? m[2] : m[2] + '.js';
    for(const name of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)){
      if(!exported[from]){ console.log(`no such module: ${from} (imported by ${f})`); bad++; continue; }
      if(!exported[from].has(name)){ console.log(`MISSING EXPORT: ${f} imports ${name} from ${from}`); bad++; }
    }
  }
}

for(const [f, s] of Object.entries(src)){
  for(const m of s.matchAll(/export\s+function\s+(parse\w*Output)/g)){
    const name = m[1];
    // A same-module caller counts: parseHuntOutput dispatches two of these itself
    // and is wired in net.js. What matters is that SOMETHING calls it, not who.
    const calls = Object.values(src)
      .join('\n')
      .split(name + '(').length - 1;
    const declared = 1;                       // `export function name(` itself
    if(calls <= declared){ console.log(`NEVER DISPATCHED: ${name} (exported by ${f})`); bad++; }
  }
}

// Every slash command the dispatcher accepts must be documented by /help, and
// /help must not describe one that no longer exists. Stale help is worse than
// none: it sends the player after a command that was renamed commits ago.
{
  // Comments stripped first: the comment on the help table itself mentions
  // `cmd==='...'` and was duly reported as an undocumented command called "...".
  const net = (src['net.js'] || '').replace(/^\s*\/\/.*$/gm, '');
  const dispatched = new Set(
    [...net.matchAll(/cmd\s*===\s*'([^']+)'/g)].map(m => m[1]));
  // The help table lists each spelling in `cmds: [...]` entries.
  const documented = new Set(
    [...net.matchAll(/cmds:\s*\[([^\]]+)\]/g)]
      .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])));
  for(const c of dispatched){
    if(!documented.has(c)){ console.log(`UNDOCUMENTED COMMAND: /${c} is dispatched but /help does not list it`); bad++; }
  }
  for(const c of documented){
    if(!dispatched.has(c)){ console.log(`HELP DESCRIBES NOTHING: /${c} is in /help but the dispatcher has no case for it`); bad++; }
  }
}

// Control characters that are never meant to be in source. Tab and the two
// newline bytes are legitimate; everything else below 0x20 is an escape that was
// eaten somewhere between the editor and the file.
const ALLOWED_CTRL = new Set([0x09, 0x0a, 0x0d]);
for(const f of files){
  const buf = readFileSync(dir + '/' + f);
  for(let i = 0; i < buf.length; i++){
    const c = buf[i];
    if(c >= 0x20 || ALLOWED_CTRL.has(c)) continue;
    const line = buf.subarray(0, i).toString('utf8').split('\n').length;
    console.log(`CONTROL CHARACTER 0x${c.toString(16).padStart(2, '0')}: ${f}:${line}`
      + ` -- almost certainly a regex \\b or \\f eaten by a shell heredoc`);
    bad++;
    break;                                   // one report per file is enough
  }
}

// (4) `node --check` treats a .js file as a SCRIPT, which accepts things the browser
// refuses -- and it accepted a broken string literal that stopped every module in the
// client from loading. An editing slip put a real newline inside appendOutput('...'),
// this file reported all clear, and the page came up blank with "Invalid or unexpected
// token" in a console nobody was watching. Parsing each file as a MODULE catches it.
const tmp = mkdtempSync(join(tmpdir(), 'wiring-'));
for(const [f, s] of Object.entries(src)){
  const mjs = join(tmp, f.replace(/\.js$/, '.mjs'));
  writeFileSync(mjs, s);
  try {
    execFileSync(process.execPath, ['--check', mjs], {stdio: ['ignore', 'ignore', 'pipe']});
  } catch(e){
    const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join('\n    ');
    console.log(`NOT VALID ES MODULE SYNTAX: ${f}\n    ${msg}`);
    bad++;
  }
}

console.log(bad ? `\n${bad} problem(s)` : `\n${files.length} modules: imports resolve, every output parser is dispatched, no stray control characters, all parse as modules`);

// EXIT NON-ZERO. This printed its findings and exited 0, so every `check && commit && run`
// chain sailed straight past a failure it had just reported -- including one that committed
// a module the browser could not parse, and then loaded it. A checker that cannot fail
// cannot gate anything.
process.exit(bad ? 1 : 0);
