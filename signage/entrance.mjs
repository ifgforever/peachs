// Builds the entrance-screen video, with sound, from entrance.json: loop scenes, then a title card before each clip
// and the clip itself. Widescreen clips play full screen; any other shape (a phone video, say) sits in a branded frame.
// Clip audio is leveled to the same loudness (-16 LUFS); everything else is silent.
// Usage: python3 -m http.server 8765 (from the repo root), then: node signage/entrance.mjs
// Options: --config <file> (default signage/entrance.json), --out <file> (default signage/peachs-entrance-loop.mp4)
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { FPS, X264, openLoop, recordScene, run } from './lib/capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? resolve(argv[argv.indexOf(name) + 1]) : def);
const configPath = opt('--config', join(here, 'entrance.json'));
const out = opt('--out', join(here, 'peachs-entrance-loop.mp4'));
const work = join(here, 'build', 'entrance');
mkdirSync(work, { recursive: true });

const FADE = 0.6;
const CREAM = '0xFFF4E8';      // the fade color every loop uses between scenes
const ESPRESSO = '0x2A160C';
const AUDIO = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
const VIDEO_AREA = { x: 820, y: 60, w: 980, h: 960 };   // where a framed (non-widescreen) clip may sit

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration', '-of', 'json', file]));
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`${file} has no video`);
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => 'rotation' in d)?.rotation ?? 0));
  const [w, h] = rot === 90 || rot === 270 ? [v.height, v.width] : [v.width, v.height];
  return { w, h, dur: Number(j.format.duration), hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
}

function fitBox(w, h) {
  const even = (n) => Math.round(n / 2) * 2;
  const k = Math.min(VIDEO_AREA.w / w, VIDEO_AREA.h / h);
  const bw = even(w * k), bh = even(h * k);
  return { x: even(VIDEO_AREA.x + (VIDEO_AREA.w - bw) / 2), y: even(VIDEO_AREA.y + (VIDEO_AREA.h - bh) / 2), w: bw, h: bh };
}

async function encodeClip(it) {
  const start = Number(it.start || 0);
  const D = Number(((it.end ? Number(it.end) : it.info.dur) - start).toFixed(3));
  it.dur = D;
  const fade = `fade=t=in:st=0:d=${FADE}:color=${CREAM},fade=t=out:st=${(D - FADE).toFixed(3)}:d=${FADE}:color=${CREAM}`;
  const args = ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(D), '-i', it.file];
  let fc;
  if (it.box) {
    const b = it.box;
    args.push('-loop', '1', '-t', String(D), '-i', it.frame);
    fc = `color=c=${ESPRESSO}:s=1920x1080:r=${FPS}:d=${D}[bg];[0:v]scale=${b.w}:${b.h}:flags=lanczos,setsar=1,fps=${FPS}[cv];` +
      `[bg][cv]overlay=${b.x}:${b.y}:shortest=1[m];[m][1:v]overlay=0:0:shortest=1,format=yuv420p,${fade}[v]`;
  } else {
    fc = `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `setsar=1,fps=${FPS},format=yuv420p,${fade}[v]`;
  }
  if (it.info.hasAudio) {
    fc += `;[0:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,` +
      `afade=t=in:d=0.3,afade=t=out:st=${(D - FADE).toFixed(3)}:d=${FADE}[a]`;
  } else {
    console.warn(`warning: ${it.clip} has no sound`);
    args.push('-f', 'lavfi', '-t', String(D), '-i', 'anullsrc=r=48000:cl=stereo');
    fc += `;[${it.box ? 2 : 1}:a]anull[a]`;
  }
  await run('ffmpeg', [...args, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', ...X264, ...AUDIO, '-t', String(D), '-movflags', '+faststart', it.out]);
  console.log('encoded', it.out);
}

// 1. Find the clips; skip any that haven't been added yet.
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const items = [];
for (const it of config.sequence) {
  if (!it.clip) { items.push(it); continue; }
  const file = resolve(dirname(configPath), it.clip);
  if (!existsSync(file)) { console.warn(`skipping ${it.clip}: file not found`); continue; }
  items.push({ ...it, file, info: await probe(file) });
}
if (!items.some((it) => it.clip)) {
  console.error('No clips found. Put the videos in signage/source/ with the names in entrance.json (see signage/README.md).');
  process.exit(1);
}

// 2. Record the loop scenes the sequence uses.
const sceneFiles = {};
const byPage = {};
for (const it of items) if (it.page) (byPage[it.page] ??= new Set()).add(it.scene);
for (const [file, ids] of Object.entries(byPage)) {
  const { browser, page, scenes } = await openLoop(file);
  for (const id of ids) {
    const s = scenes.find((x) => x.id === id);
    if (!s) throw new Error(`${file} has no scene "${id}"`);
    const f = join(work, `${file.replace(/\W+/g, '-')}${id}.mp4`);
    await recordScene(page, s, f);
    sceneFiles[`${file}#${id}`] = { file: f, dur: s.dur };
  }
  await browser.close();
}

// 3. Record each clip's title card, and its frame if it isn't widescreen.
const cards = await openLoop('entrance.html');
const intro = cards.scenes.find((s) => s.id === 'intro');
let n = 0;
for (const it of items.filter((x) => x.clip)) {
  n++;
  it.box = it.info.w / it.info.h >= 1.6 ? null : fitBox(it.info.w, it.info.h);
  await cards.page.evaluate(([c, b]) => window.setClip(c, b), [{ eyebrow: it.eyebrow, title: it.title, accent: it.accent, credit: it.credit }, it.box]);
  it.card = join(work, `clip${n}-intro.mp4`);
  await recordScene(cards.page, intro, it.card);
  if (it.box) {
    it.frame = join(work, `clip${n}-frame.png`);
    await cards.page.evaluate(() => window.seek('frame', 0));
    await cards.page.screenshot({ path: it.frame, omitBackground: true });
  }
  it.out = join(work, `clip${n}.mp4`);
}
await cards.browser.close();

// 4. Fit each clip to the screen and level its sound.
for (const it of items) if (it.clip) await encodeClip(it);

// 5. Join everything. Silent parts get a silent audio track so the whole file has one continuous soundtrack.
const segs = [];
for (const it of items) {
  if (it.page) segs.push({ ...sceneFiles[`${it.page}#${it.scene}`], audio: false });
  else segs.push({ file: it.card, dur: intro.dur, audio: false }, { file: it.out, dur: it.dur, audio: true });
}
const args = ['-y', '-loglevel', 'error'];
const filters = [];
let input = 0;
for (const [i, s] of segs.entries()) {
  args.push('-i', s.file);
  const v = input++;
  let a = `${v}:a`;
  if (!s.audio) {
    args.push('-f', 'lavfi', '-t', String(s.dur), '-i', 'anullsrc=r=48000:cl=stereo');
    a = `${input++}:a`;
  }
  filters.push(`[${v}:v]setsar=1,fps=${FPS},format=yuv420p[v${i}]`, `[${a}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
}
filters.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${segs.length}:v=1:a=1[v][a]`);
// The final pass uses CRF 23 instead of 18: clips saved from YouTube are only ~2.4 Mbps, so this looks the same
// (SSIM 0.99 against CRF 18) and keeps a two-minute loop around 30 MB, small enough to send.
const FINAL = X264.map((a, i, all) => (all[i - 1] === '-crf' ? '23' : a));
await run('ffmpeg', [...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', ...FINAL, ...AUDIO, '-movflags', '+faststart', out]);
const total = segs.reduce((t, s) => t + s.dur, 0);
console.log(`wrote ${out} (${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')})`);
