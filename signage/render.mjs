// Renders loop.html to an MP4 for BrightSign players (1920x1080, 30fps, H.264 High, no audio).
// Usage: python3 -m http.server 8765 (from the repo root), then: node signage/render.mjs [sceneId ...]
// Each scene becomes signage/build/NN-<id>.mp4; they are then joined into signage/peachs-instore-loop.mp4.
import { createRequire } from 'module';
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');
const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, 'build');
const FPS = 30;
const URL = process.env.LOOP_URL || 'http://localhost:8765/signage/loop.html';
const only = process.argv.slice(2);
mkdirSync(build, { recursive: true });

const encode = (out) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
  '-r', String(FPS), '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
const scenes = await page.evaluate(() => window.SCENES);

const parts = [];
for (const [i, s] of scenes.entries()) {
  const out = join(build, `${String(i + 1).padStart(2, '0')}-${s.id}.mp4`);
  parts.push(out);
  if (only.length && !only.includes(s.id)) continue;
  const ff = encode(out);
  const done = new Promise((res, rej) => ff.on('close', (c) => (c ? rej(new Error('ffmpeg ' + c)) : res())));
  const frames = Math.round(s.dur * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate(([id, t]) => window.seek(id, t), [s.id, f / FPS]);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  console.log('rendered', out);
}
await browser.close();

const list = join(build, 'concat.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const final = join(here, 'peachs-instore-loop.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
console.log('wrote', final);
