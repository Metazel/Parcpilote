// Turns the single-file build into a page fragment for hosted previews (no doctype/html/head/body).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [src = 'dist-single/index.html', out = 'dist-artifact/parcpilote.html'] = process.argv.slice(2);
const html = readFileSync(src, 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
const keep = (re) => [...head.matchAll(re)].map((m) => m[0]).join('\n');
const fragment = [
  keep(/<title>[\s\S]*?<\/title>/g),
  '<meta name="claude:viewport-fit-sides" content="cover">',
  keep(/<meta name="(?:description|referrer)"[^>]*>/g),
  keep(/<style[\s\S]*?<\/style>/g),
  keep(/<script[\s\S]*?<\/script>/g),
  body.trim(),
].filter(Boolean).join('\n');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, fragment);
console.log(`${out}: ${(fragment.length / 1024).toFixed(1)} kB`);
