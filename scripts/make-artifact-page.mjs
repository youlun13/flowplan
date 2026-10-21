// 把 Vite 產出的完整 index.html 轉成「無 doctype/html/head/body」的片段，供 claude.ai Artifact 預覽使用。
// 正式部署（Cloudflare Pages / Vercel / GitHub Pages）直接用 dist/ 即可，不需要這個檔。
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const keep = head
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('<meta charset') && !l.startsWith('<meta name="viewport"'))
  .join('\n');
// title 放最前面（Artifact 只掃描前 8KB 找 title）
const title = keep.match(/<title>.*<\/title>/)[0];
const rest = keep.replace(title, '').trim();
writeFileSync('dist/flowplan.html', `${title}\n${rest}\n${body.trim()}\n`);
console.log('dist/flowplan.html written');
