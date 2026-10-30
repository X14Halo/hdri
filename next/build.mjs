// Builds next/index.html: one self-contained page (styles, UI script, and the render worker as an embedded string).
// usage: node next/build.mjs
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.dirname(fileURLToPath(import.meta.url)), src = p => fs.readFileSync(path.join(root, 'src', p), 'utf8');
const shared = ['shared/core.js', 'shared/params.js', 'shared/physics.js'].map(src).join('\n');
const shaders = Object.fromEntries(fs.readdirSync(path.join(root, 'src/shaders')).filter(f => f.endsWith('.wgsl')).map(f => [f.replace('.wgsl', ''), src('shaders/' + f)]));
const workerSrc = `${shared}\nconst WGSL = ${JSON.stringify(shaders)};\n${src('worker/main.js')}`;
const main = `${shared}\nconst WORKER_SRC = ${JSON.stringify(workerSrc)};\n${src('ui/app.js')}`.replace(/<\/script/gi, '<\\/script');
let html = src('index.html').replace('/*@STYLE*/', () => src('ui/style.css')).replace('/*@MAIN*/', () => main);
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`next/index.html: ${(html.length/1024).toFixed(0)} KB`);
// syntax check of both scripts (duplicate declarations etc. would otherwise only show up in the browser)
import { execFileSync } from 'child_process'; import os from 'os';
for (const [n, code] of [['main', main.replace(/<\\\/script/gi, '</script')], ['worker', workerSrc]]){ const f = path.join(os.tmpdir(), `sky-next-${n}.js`); fs.writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], {stdio:'pipe'}); } catch (e){ console.error(`${n} script:`, e.stderr.toString()); process.exit(1); } }
