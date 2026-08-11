// Two checks the client had no way of catching, both of which bit today:
//   1. an import naming something the module does not export  (would throw)
//   2. an exported output parser that nothing ever calls       (silently dead)
import { readdirSync, readFileSync } from 'node:fs';

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

console.log(bad ? `\n${bad} problem(s)` : `\n${files.length} modules: imports resolve and every output parser is dispatched`);
