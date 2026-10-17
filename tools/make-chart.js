#!/usr/bin/env node
/* =====================================================================
   リズムスターズに「自分の曲（音声ファイル）」を追加する道具
     node tools/make-chart.js <音声ファイル> <id> <表示名> [ジャンル] [テーマ] [色#hex]
     例: node tools/make-chart.js "C:\Users\me\Music\曲.wav" mysong "マイソング" バトル cat2 #ff4d8d
   やること:
     1. ffmpeg で games/music/<id>.m4a（AAC 128k）を作る（ゲームが再生する音）
     2. 音を解析して BPM・拍の位置・音の立ち上がり（オンセット）を見つける
     3. やさしい／ふつう／むずかしい の譜面を自動生成して games/music/charts.js に書く
   必要なもの: Node.js、ffmpeg（PATH に通っていること）
   ===================================================================== */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');

const [,, input, id, name, genre = 'ORIGINAL', theme = 'cat2', hex = '#ff5e5e'] = process.argv;
if (!input || !id || !name) { console.log('使い方: node tools/make-chart.js <音声ファイル> <id> <表示名> [ジャンル] [テーマ] [色#hex]'); process.exit(1); }
if (!/^[a-z0-9_]+$/.test(id)) { console.log('id は半角英数字と _ だけにしてください'); process.exit(1); }
const root = path.resolve(__dirname, '..');
const musicDir = path.join(root, 'games', 'music');
fs.mkdirSync(musicDir, { recursive: true });

// ---------- 1. 変換 ----------
const SR = 22050;
const m4a = path.join(musicDir, `${id}.m4a`);
const raw = path.join(os.tmpdir(), `neonfesta-${id}.raw`);
console.log('変換中…');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '2', '-c:a', 'aac', '-b:a', '128k', m4a]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', String(SR), '-f', 'f32le', raw]);
const buf = fs.readFileSync(raw);
const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const duration = pcm.length / SR;
console.log(`  長さ ${duration.toFixed(1)} 秒`);

// ---------- 2. 解析 ----------
const N = 1024, HOP = 256;
const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
// 簡単な FFT（実数入力）
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j], vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const frames = Math.floor((pcm.length - N) / HOP);
const flux = new Float32Array(frames), lowE = new Float32Array(frames), midE = new Float32Array(frames), highE = new Float32Array(frames), rms = new Float32Array(frames);
const re = new Float32Array(N), im = new Float32Array(N); let prev = new Float32Array(N / 2);
const binHz = SR / N, LOW = Math.round(220 / binHz), MID = Math.round(2200 / binHz);
for (let f = 0; f < frames; f++) {
  const o = f * HOP; let e = 0;
  for (let i = 0; i < N; i++) { const v = pcm[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
  rms[f] = Math.sqrt(e / N);
  fft(re, im);
  let fl = 0, lo = 0, mi = 0, hi = 0;
  for (let k = 1; k < N / 2; k++) {
    const mag = Math.log1p(10 * Math.hypot(re[k], im[k]));
    const d = mag - prev[k]; if (d > 0) { fl += d; if (k < LOW) lo += d; else if (k < MID) mi += d; else hi += d; }
    prev[k] = mag;
  }
  flux[f] = fl; lowE[f] = lo; midE[f] = mi; highE[f] = hi;
}
// なめらかに
const sm = new Float32Array(frames); for (let f = 0; f < frames; f++) sm[f] = (flux[Math.max(0, f - 1)] + flux[f] + flux[Math.min(frames - 1, f + 1)]) / 3;
let gmax = 0; for (let f = 0; f < frames; f++) gmax = Math.max(gmax, sm[f]);
// オンセット（山）を拾う
const onsets = [];
const W = 20;
for (let f = 3; f < frames - 3; f++) {
  const v = sm[f]; if (v < gmax * 0.04) continue;
  let isPeak = true; for (let k = -3; k <= 3; k++) if (k && sm[f + k] > v) { isPeak = false; break; }
  if (!isPeak) continue;
  let mean = 0, cnt = 0; for (let k = -W; k <= W; k++) { const j = f + k; if (j >= 0 && j < frames) { mean += sm[j]; cnt++; } }
  mean /= cnt;
  if (v > mean * 1.35 + gmax * 0.02) {
    if (onsets.length && f - onsets[onsets.length - 1].f < 4) { if (v > onsets[onsets.length - 1].v) onsets.pop(); else continue; }
    onsets.push({ f, t: (f * HOP + N / 2) / SR, v, lo: lowE[f], mi: midE[f], hi: highE[f] });
  }
}
console.log(`  オンセット ${onsets.length} 個`);
// BPM（自己相関 ＋ 60〜200 の範囲、半分/倍のゆれを考慮）
function acf(lag) { let s = 0; for (let f = 0; f + lag < frames; f++) s += sm[f] * sm[f + lag]; return s / (frames - lag); }
let best = { bpm: 120, score: -1 };
for (let bpm = 60; bpm <= 200; bpm += 0.5) {
  const lag = Math.round(60 / bpm * SR / HOP);
  const w = Math.exp(-Math.pow((bpm - 130) / 55, 2) * 0.5);   // 100〜160 あたりを少し優先
  const s = (acf(lag) + 0.5 * acf(lag * 2) + 0.3 * acf(Math.round(lag / 2))) * (0.6 + 0.4 * w);
  if (s > best.score) best = { bpm, score: s };
}
// 細かく追い込む（±3%・0.05 刻み）: 拍の位置にオンセットが乗る量で評価
function combScore(bpm, phase) { const beat = 60 / bpm; let s = 0, n = 0; for (let t = phase; t < duration; t += beat) { const f = Math.round((t * SR - N / 2) / HOP); if (f >= 0 && f < frames) { s += Math.max(sm[f], sm[Math.max(0, f - 1)], sm[Math.min(frames - 1, f + 1)]); n++; } } return s / Math.max(1, n); }
let fine = { bpm: best.bpm, phase: 0, score: -1 };
for (let bpm = best.bpm * 0.97; bpm <= best.bpm * 1.03; bpm += 0.05) {
  const beat = 60 / bpm;
  for (let ph = 0; ph < beat; ph += HOP / SR) { const s = combScore(bpm, ph); if (s > fine.score) fine = { bpm, phase: ph, score: s }; }
}
const BPM = Math.round(fine.bpm * 10) / 10, BEAT = 60 / BPM, STEP = BEAT / 4;
// 拍の位置を最初のオンセット付近まで戻す（譜面の 0 拍目）
let offset = fine.phase; while (offset - BEAT > 0) offset -= BEAT;
console.log(`  BPM ${BPM}（拍の始まり ${offset.toFixed(3)} 秒）`);

// ---------- 3. 譜面 ----------
// 16分のグリッドにそろえる（同じマスは強いほうだけ）
const grid = new Map();
const strengths = onsets.map(o => o.v).sort((a, b) => a - b);
const pct = p => strengths[Math.min(strengths.length - 1, Math.floor(strengths.length * p))] || 0;
onsets.forEach(o => {
  const g = Math.round((o.t - offset) / STEP); if (g < 0) return;
  const t = offset + g * STEP; if (Math.abs(t - o.t) > STEP * 0.5) return;
  const cur = grid.get(g); if (!cur || o.v > cur.v) grid.set(g, Object.assign({}, o, { g, t }));
});
const slots = [...grid.values()].sort((a, b) => a.g - b.g);
// 最初の 0.6 秒と、最初の強い音より前は使わない
const firstStrong = slots.find(s => s.v >= pct(0.5) && s.t > 0.6);
const usable = slots.filter(s => firstStrong && s.t >= firstStrong.t - 1e-6);
console.log(`  グリッド上の音 ${usable.length} 個`);

function rmsAt(t) { const f = Math.round((t * SR - N / 2) / HOP); return rms[Math.max(0, Math.min(frames - 1, f))]; }
function pickLane(o, prev, prevT, rnd) {
  const tot = o.lo + o.mi + o.hi + 1e-9, lo = o.lo / tot, hi = o.hi / tot;
  let lane;
  if (prev != null && o.t - prevT < STEP * 2.5) { lane = prev + (rnd() < 0.5 ? -1 : 1); if (lane < 0) lane = 1; if (lane > 3) lane = 2; }   // 速い連打はとなりへ
  else if (lo > 0.45) lane = prev === 0 ? 3 : prev === 3 ? 0 : (rnd() < 0.5 ? 0 : 3);
  else if (hi > 0.45) lane = prev === 1 ? 2 : prev === 2 ? 1 : (rnd() < 0.5 ? 1 : 2);
  else { lane = Math.floor(rnd() * 4); if (lane === prev) lane = (lane + 1 + Math.floor(rnd() * 3)) % 4; }
  return lane;
}
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function makeChart(di) {
  const rnd = lcg(1234 + di * 77);
  const thr = [pct(0.3), pct(0.35), pct(0.2)][di];
  const maxPerSec = [2.2, 4.2, 7.5][di], minGap = [0.28, 0.14, 0.09][di];
  const notes = []; let prevLane = null, prevT = -9;
  for (let i = 0; i < usable.length; i++) {
    const o = usable[i];
    const onBeat = o.g % 4 === 0, on8 = o.g % 2 === 0;
    let ok;
    if (di === 0) ok = (onBeat && o.v >= thr) || (on8 && o.v >= pct(0.82));
    else if (di === 1) ok = (on8 && o.v >= thr) || (o.v >= pct(0.88));
    else ok = o.v >= thr;
    if (!ok) continue;
    if (o.t - prevT < minGap) continue;
    // 直近1秒の密度
    let dens = 0; for (let k = notes.length - 1; k >= 0 && o.t - notes[k].t < 1; k--) dens++;
    if (dens >= maxPerSec) continue;
    const lane = pickLane(o, prevLane, prevT, rnd);
    notes.push({ t: o.t, lane, end: 0, v: o.v, g: o.g });
    // 同時押し（むずかしい・強いアクセント）
    if (di === 2 && o.v >= pct(0.93) && o.t - prevT > BEAT * 0.9 && rnd() < 0.7) { const l2 = lane <= 1 ? lane + 2 : lane - 2; notes.push({ t: o.t, lane: l2, end: 0, v: o.v, g: o.g }); }
    prevLane = lane; prevT = o.t;
  }
  // ホールド: 次の音までのすき間が長く、音が伸びているところ
  const holdGap = [2.0, 1.25, 1.0][di] * BEAT; let lastHoldEnd = -9;
  for (let i = 0; i < notes.length - 1; i++) {
    const n = notes[i], next = notes[i + 1];
    if (next.t - n.t < holdGap || n.t < lastHoldEnd + BEAT * 2) continue;
    const mid = rmsAt(n.t + (next.t - n.t) / 2), at = rmsAt(n.t + 0.03);
    if (at <= 1e-4 || mid < at * 0.55) continue;
    if (notes.some((m, j) => j !== i && Math.abs(m.t - n.t) < 1e-6)) continue;   // 同時押しは伸ばさない
    n.end = Math.round((Math.min(next.t - STEP, n.t + BEAT * 4)) * 1000) / 1000;
    if (n.end - n.t < BEAT * 0.5) { n.end = 0; continue; }
    lastHoldEnd = n.end;
  }
  return notes.map(n => [Math.round(n.t * 1000) / 1000, n.lane, n.end]);
}
let charts = [makeChart(0), makeChart(1), makeChart(2)];
// 最初の音まで長い（6秒以上）なら、2拍前から再生を始める（イントロの無音で待たせない）
const firstT = Math.min(...charts.map(c => c.length ? c[0][0] : Infinity));
let start = 0;
if (firstT > 6) { start = Math.max(0, Math.floor((firstT - BEAT * 2 - offset) / BEAT) * BEAT + offset); start = Math.round(start * 1000) / 1000; }
if (start > 0) { charts = charts.map(c => c.map(([t, l, e]) => [Math.round((t - start) * 1000) / 1000, l, e ? Math.round((e - start) * 1000) / 1000 : 0])); console.log(`  再生開始位置 ${start} 秒（イントロを飛ばす）`); }
charts.forEach((c, i) => console.log(`  ${['やさしい', 'ふつう', 'むずかしい'][i]}: ${c.length} ノーツ（ロング ${c.filter(n => n[2]).length}）`));
const hx = hex.replace('#', ''); const color = [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
const entry = { id, name, genre, bpm: BPM, offset: Math.round(offset * 1000) / 1000, start, length: Math.round((duration - start) * 10) / 10, audio: `music/${id}.m4a`, hex, color, theme, charts };

// ---------- 4. charts.js に書く ----------
const out = path.join(musicDir, 'charts.js');
let list = [];
if (fs.existsSync(out)) { try { const src = fs.readFileSync(out, 'utf8'); const m = src.match(/=\s*(\[[\s\S]*\]);/); if (m) list = JSON.parse(m[1]); } catch (e) { list = []; } }
list = list.filter(x => x.id !== id); list.push(entry);
fs.writeFileSync(out, `// リズムスターズの追加曲（tools/make-chart.js が自動生成。音声は同じフォルダの .m4a）\nwindow.RHYTHM_EXT_SONGS = ${JSON.stringify(list)};\n`);
try { fs.unlinkSync(raw); } catch (e) {}
console.log(`完了: ${m4a}\n      ${out}（曲 ${list.length} 本）`);
