// Renders a loop page to an MP4 for BrightSign players (1920x1080, 30fps, H.264 High, no audio).
// Usage: python3 -m http.server 8765 (from the repo root), then:
//   node signage/render.mjs [loop] [sceneId ...]
// loop is "peachs" (loop.html, the default) or "family" (family.html, every Rome's Joy company).
// Each scene becomes signage/build/<loop>/NN-<id>.mp4; they are then joined into the loop's MP4.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openLoop, recordScene } from './lib/capture.mjs';

const LOOPS = {
  peachs: { page: 'loop.html', out: 'peachs-instore-loop.mp4' },
  family: { page: 'family.html', out: 'romesjoy-family-loop.mp4' },
};

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const name = LOOPS[args[0]] ? args.shift() : 'peachs';
const loop = LOOPS[name];
const only = args;
const build = join(here, 'build', name);
mkdirSync(build, { recursive: true });

const { browser, page, scenes } = await openLoop(loop.page);
const parts = [];
for (const [i, s] of scenes.entries()) {
  const out = join(build, `${String(i + 1).padStart(2, '0')}-${s.id}.mp4`);
  parts.push(out);
  if (only.length && !only.includes(s.id)) continue;
  await recordScene(page, s, out);
}
await browser.close();

const missing = parts.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Not joining: these scenes have never been rendered. Run "node signage/render.mjs ${name}" once with no scene names.\n` + missing.join('\n'));
  process.exit(1);
}
const list = join(build, 'concat.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const final = join(here, loop.out);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
console.log('wrote', final);
