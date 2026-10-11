// Shared by render.mjs and entrance.mjs: opens a loop page in headless Chromium and records its scenes frame by frame.
// Pages expose window.SCENES ([{ id, dur }]) and window.seek(id, t), and set window.__ready once fonts and images are loaded.
import { createRequire } from 'module';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || '/opt/node-tools/node_modules/playwright');

export const FPS = 30;
export const BASE = process.env.LOOP_BASE || 'http://localhost:8765/signage/';

// H.264 High, 1920x1080, 30fps, no audio: what BrightSign players expect.
export const X264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', '-r', String(FPS)];

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (c) => (c ? reject(new Error(`${cmd} exited with ${c}`)) : resolve(out)));
  });
}

export async function openLoop(file) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(BASE + file, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  const scenes = await page.evaluate(() => window.SCENES);
  return { browser, page, scenes };
}

export async function recordScene(page, scene, out) {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    ...X264, '-movflags', '+faststart', '-an', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c ? rej(new Error('ffmpeg ' + c)) : res())));
  const frames = Math.round(scene.dur * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate(([id, t]) => window.seek(id, t), [scene.id, f / FPS]);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  console.log('rendered', out);
}
