/* =====================================================================
   preview.js — 各ゲームの雰囲気を小さく動かす描画（ホームのカード・ポスター・宣伝動画で共用）
   使い方:  FES_PV.draw(id, ctx, w, h, t, accentColor)            … モチーフだけ
            FES_PV.drawScreen(ctx, id, x, y, w, h, t, accent, opts) … 模擬プレイ画面（枠＋HUD＋モチーフ）
   画像なし・外部依存なし。id は games/ のファイル名（rhythm, shooter, …）。
   ===================================================================== */
(function (global) {
  'use strict';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  // 古いブラウザ向け: roundRect がなければ足す
  if (global.CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(Array.isArray(r) ? r[0] : (r || 0), w / 2, h / 2);
      this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r); this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
      return this;
    };
  }
  const PV = {
    rhythm(c, w, h, t, col) {
      const lanes = 4, lw = w / lanes;
      for (let i = 0; i < lanes; i++) { c.fillStyle = i % 2 ? 'rgba(255,255,255,.04)' : 'rgba(255,255,255,.07)'; c.fillRect(i * lw, 0, lw, h); }
      c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0, h * .78, w, 2);
      for (let i = 0; i < 10; i++) {
        const lane = (i * 7) % lanes, y = ((t * 110 + i * 53) % (h + 40)) - 20;
        const hit = Math.abs(y - h * .78) < 6;
        c.fillStyle = hit ? '#fff' : col; c.globalAlpha = hit ? 1 : .85;
        c.beginPath(); c.roundRect(lane * lw + 4, y - 4, lw - 8, 8, 4); c.fill();
        if (hit) { c.globalAlpha = .5; c.beginPath(); c.arc(lane * lw + lw / 2, h * .78, 14, 0, 6.28); c.fill(); }
      }
      c.globalAlpha = 1;
    },
    shooter(c, w, h, t, col) {
      c.fillStyle = 'rgba(255,255,255,.5)';
      for (let i = 0; i < 18; i++) { const x = (i * 37) % w, y = (t * (40 + i % 3 * 30) + i * 31) % h; c.fillRect(x, y, 1.5, 4); }
      const sx = w / 2 + Math.sin(t * 1.3) * w * .25, sy = h - 14;
      c.fillStyle = col; c.beginPath(); c.moveTo(sx, sy - 12); c.lineTo(sx - 9, sy + 6); c.lineTo(sx + 9, sy + 6); c.closePath(); c.fill();
      c.fillStyle = '#ffd36e'; for (let i = 0; i < 4; i++) { const y = sy - 16 - ((t * 240 + i * 28) % (h + 10)); c.fillRect(sx - 1.5, y, 3, 9); }
      for (let i = 0; i < 4; i++) { const ex = (i + .5) * w / 4 + Math.sin(t * 2 + i) * 10, ey = 14 + Math.sin(t * 1.5 + i * 2) * 6; c.fillStyle = '#ff5e5e'; c.beginPath(); c.arc(ex, ey, 6, 0, 6.28); c.fill(); }
    },
    puzzle(c, w, h, t, col) {
      const cols = 7, rows = 3, s = Math.min(w / cols, h / rows), ox = (w - s * cols) / 2, oy = (h - s * rows) / 2;
      const C = ['#ff4d6d', '#4f8cff', '#5cff8d', '#ffd36e', '#b06bff', '#5ee7ff'];
      for (let r = 0; r < rows; r++) for (let i = 0; i < cols; i++) {
        const k = (r * cols + i), pulse = Math.floor(t * 2) % (cols * rows) === k ? 1.25 : 1;
        c.fillStyle = C[(k * 5 + r) % C.length]; c.globalAlpha = .9;
        const cx = ox + i * s + s / 2, cy = oy + r * s + s / 2, rr = s * .33 * pulse;
        c.beginPath(); c.moveTo(cx, cy - rr); c.lineTo(cx + rr, cy); c.lineTo(cx, cy + rr); c.lineTo(cx - rr, cy); c.closePath(); c.fill();
      }
      c.globalAlpha = 1;
    },
    drops(c, w, h, t, col) {
      const cols = 6, rows = 3, s = Math.min(w / cols, h / rows), ox = (w - s * cols) / 2, oy = (h - s * rows) / 2;
      const C = ['#ff4d4d', '#3b9bff', '#3ddc6b', '#ffd84a', '#b45cff', '#ff7ad9'];
      for (let r = 0; r < rows; r++) for (let i = 0; i < cols; i++) {
        const k = r * cols + i, cx = ox + i * s + s / 2, cy = oy + r * s + s / 2, rr = s * 0.36;
        const g = c.createRadialGradient(cx - rr * 0.3, cy - rr * 0.3, 1, cx, cy, rr); g.addColorStop(0, '#fff'); g.addColorStop(0.4, C[(k * 7 + r) % 6]); g.addColorStop(1, 'rgba(0,0,0,.6)');
        c.fillStyle = g; c.beginPath(); c.arc(cx, cy, rr, 0, 6.28); c.fill();
      }
      // なぞっているドロップ（指のあと）
      const k = (t * 0.6) % 1, px = ox + s * (0.5 + 4.5 * k), py = oy + s * 1.5 + Math.sin(k * 6.28) * s * 0.9;
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = s * 0.3; c.lineCap = 'round'; c.beginPath(); c.moveTo(ox + s * 0.5, oy + s * 1.5); c.quadraticCurveTo(ox + s * 2.5, oy + s * 1.5 + s * 1.2, px, py); c.stroke();
      const g2 = c.createRadialGradient(px - 4, py - 4, 1, px, py, s * 0.46); g2.addColorStop(0, '#fff'); g2.addColorStop(0.4, col); g2.addColorStop(1, 'rgba(0,0,0,.5)');
      c.fillStyle = g2; c.beginPath(); c.arc(px, py, s * 0.46, 0, 6.28); c.fill();
      c.font = '900 10px sans-serif'; c.textAlign = 'center'; c.fillStyle = '#ffd36e'; c.fillText((2 + Math.floor(t) % 4) + ' COMBO', w - 34, 12);
    },
    typing(c, w, h, t, col) {
      const word = 'NEONFESTA', n = Math.floor(t * 4) % (word.length + 4);
      c.font = '900 26px Consolas, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(255,255,255,.25)'; c.fillText(word, w / 2, h / 2 - 6);
      c.fillStyle = col; c.fillText(word.slice(0, Math.min(n, word.length)) + (Math.floor(t * 6) % 2 ? '|' : ' ') + ' '.repeat(Math.max(0, word.length - n - 1)), w / 2, h / 2 - 6);
      const mx = w - 20 - ((t * 25) % (w * .5));
      c.fillStyle = '#b06bff'; c.beginPath(); c.arc(mx, h - 16, 9, 0, 6.28); c.fill();
      c.fillStyle = '#fff'; c.fillRect(mx - 4, h - 19, 3, 3); c.fillRect(mx + 2, h - 19, 3, 3);
    },
    racing(c, w, h, t, col) {
      const hz = h * .42;
      const sky = c.createLinearGradient(0, 0, 0, hz); sky.addColorStop(0, '#2a1458'); sky.addColorStop(1, '#ff6a3d'); c.fillStyle = sky; c.fillRect(0, 0, w, hz);
      c.fillStyle = '#ffd36e'; c.beginPath(); c.arc(w * .5, hz, 16, Math.PI, 0); c.fill();
      c.fillStyle = '#12102a'; c.fillRect(0, hz, w, h - hz);
      c.fillStyle = '#2b2b45'; c.beginPath(); c.moveTo(w * .46, hz); c.lineTo(w * .54, hz); c.lineTo(w * .95, h); c.lineTo(w * .05, h); c.closePath(); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 2;
      for (let i = 0; i < 6; i++) { const p = ((t * 1.2 + i / 6) % 1), y = hz + (h - hz) * p * p, y2 = hz + (h - hz) * Math.min(1, (p + .05) * (p + .05)); c.beginPath(); c.moveTo(w / 2, y); c.lineTo(w / 2, y2); c.stroke(); }
      const cx = w / 2 + Math.sin(t * 1.7) * 10; c.fillStyle = col; c.beginPath(); c.roundRect(cx - 14, h - 22, 28, 14, 4); c.fill();
      c.fillStyle = '#5ee7ff'; c.fillRect(cx - 9, h - 20, 18, 4);
    },
    runner(c, w, h, t, col) {
      c.fillStyle = 'rgba(255,255,255,.12)'; for (let i = 0; i < 5; i++) { const x = (w - (t * 30 + i * 60) % (w + 60)); c.beginPath(); c.arc(x, 18 + i * 4, 10, 0, 6.28); c.fill(); }
      c.fillStyle = '#3b2a5a'; c.fillRect(0, h - 16, w, 16);
      const jumpT = (t * 1.4) % 1, jy = Math.sin(jumpT * Math.PI) * 26;
      const x = 34, y = h - 16 - 12 - jy;
      c.fillStyle = col; c.beginPath(); c.arc(x, y, 11, 0, 6.28); c.fill();
      c.beginPath(); c.moveTo(x - 9, y - 7); c.lineTo(x - 6, y - 16); c.lineTo(x - 1, y - 9); c.fill(); c.beginPath(); c.moveTo(x + 9, y - 7); c.lineTo(x + 6, y - 16); c.lineTo(x + 1, y - 9); c.fill();
      c.fillStyle = '#2a2200'; c.fillRect(x - 5, y - 1, 3, 3); c.fillRect(x + 2, y - 1, 3, 3);
      for (let i = 0; i < 2; i++) { const ox = w - ((t * 120 + i * w * .55) % (w + 20)); c.fillStyle = '#ff5e5e'; c.fillRect(ox, h - 30, 12, 14); }
      for (let i = 0; i < 3; i++) { const cx = w - ((t * 120 + 40 + i * 25 + (i % 2) * 70) % (w + 20)); c.fillStyle = '#ffd36e'; c.beginPath(); c.arc(cx, h - 50 - (i % 2) * 10, 4, 0, 6.28); c.fill(); }
    },
    mole(c, w, h, t, col) {
      c.fillStyle = '#4a8d3a'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 3; i++) {
        const x = (i + .5) * w / 3, y = h * .62;
        c.fillStyle = '#3a2416'; c.beginPath(); c.ellipse(x, y, 24, 10, 0, 0, 6.28); c.fill();
        const up = Math.max(0, Math.sin(t * 2.2 + i * 2.1));
        if (up > 0.05) {
          c.save(); c.beginPath(); c.rect(x - 30, y - 60, 60, 60); c.clip();
          c.fillStyle = i === 1 && Math.floor(t) % 4 === 0 ? '#ffd36e' : '#8b5a2b'; c.beginPath(); c.arc(x, y + 8 - up * 26, 13, 0, 6.28); c.fill();
          c.fillStyle = '#000'; c.fillRect(x - 6, y + 2 - up * 26, 3, 3); c.fillRect(x + 3, y + 2 - up * 26, 3, 3);
          c.restore();
        }
      }
    },
    hockey(c, w, h, t, col) {
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2; c.strokeRect(8, 8, w - 16, h - 16);
      c.beginPath(); c.moveTo(w / 2, 8); c.lineTo(w / 2, h - 8); c.stroke(); c.beginPath(); c.arc(w / 2, h / 2, 14, 0, 6.28); c.stroke();
      const px = w / 2 + Math.sin(t * 2.3) * (w * .38), py = h / 2 + Math.sin(t * 3.7) * (h * .3);
      c.fillStyle = '#ffd36e'; c.beginPath(); c.arc(px, py, 5, 0, 6.28); c.fill();
      c.fillStyle = col; c.beginPath(); c.arc(22, clamp(py, 20, h - 20), 9, 0, 6.28); c.fill();
      c.fillStyle = '#ff5e5e'; c.beginPath(); c.arc(w - 22, clamp(h - py, 20, h - 20), 9, 0, 6.28); c.fill();
    },
    quiz(c, w, h, t, col) {
      c.font = '900 56px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = 'rgba(255,255,255,.12)'; c.fillText('?', w / 2, h / 2 + 2);
      const sel = Math.floor(t * 1.5) % 4;
      for (let i = 0; i < 4; i++) {
        const x = 12 + (i % 2) * (w / 2), y = 10 + Math.floor(i / 2) * (h / 2), bw = w / 2 - 18, bh = h / 2 - 14;
        c.fillStyle = i === sel ? col : 'rgba(255,255,255,.1)'; c.globalAlpha = i === sel ? .9 : 1;
        c.beginPath(); c.roundRect(x, y, bw, bh, 8); c.fill();
        c.globalAlpha = 1; c.fillStyle = '#fff'; c.font = '900 14px sans-serif'; c.fillText(String.fromCharCode(65 + i), x + 14, y + bh / 2);
      }
    },
    breakout(c, w, h, t, col) {
      const cols = 9, bw = (w - 16) / cols, C = ['#ff4d8d', '#ff9f43', '#ffd36e', '#5cff8d'];
      for (let r = 0; r < 4; r++) for (let i = 0; i < cols; i++) { if ((r * 3 + i + Math.floor(t * 2)) % 11 === 0) continue; c.fillStyle = C[r]; c.beginPath(); c.roundRect(8 + i * bw + 1, 8 + r * 10, bw - 2, 8, 2); c.fill(); }
      const bx = w / 2 + Math.sin(t * 3.1) * w * .4, by = h * .62 + Math.sin(t * 5.3) * h * .22;
      c.fillStyle = '#fff'; c.beginPath(); c.arc(bx, by, 4, 0, 6.28); c.fill();
      c.fillStyle = col; c.beginPath(); c.roundRect(clamp(bx - 18, 6, w - 42), h - 12, 36, 6, 3); c.fill();
    },
    duel(c, w, h, t, col) {
      c.fillStyle = 'rgba(79,140,255,.35)'; c.fillRect(0, 0, w / 2, h); c.fillStyle = 'rgba(255,94,94,.35)'; c.fillRect(w / 2, 0, w / 2, h);
      c.font = '900 44px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = 'rgba(255,255,255,.85)';
      const b = i => 1 + .12 * Math.max(0, Math.sin(t * 5 + i * Math.PI));
      c.save(); c.translate(w * .25, h / 2); c.scale(b(0), b(0)); c.fillText('A', 0, 0); c.restore();
      c.save(); c.translate(w * .75, h / 2); c.scale(b(1), b(1)); c.fillText('L', 0, 0); c.restore();
      c.strokeStyle = '#ffd36e'; c.lineWidth = 3; c.lineJoin = 'round'; c.beginPath(); c.moveTo(w / 2 + 6, 4); c.lineTo(w / 2 - 6, h * .45); c.lineTo(w / 2 + 5, h * .5); c.lineTo(w / 2 - 7, h - 4); c.stroke();
    },
    stack(c, w, h, t, col) {
      // 積み上がる塔と、上で左右に動くブロック
      const n = 7, bh = Math.min(10, h / 9), cx = w / 2;
      for (let i = 0; i < n; i++) { const bw = 70 - i * 6, y = h - 6 - (i + 1) * bh; c.fillStyle = `hsl(${(200 + i * 18) % 360} 95% ${i === n - 1 ? 60 : 48}%)`; c.fillRect(cx - bw / 2, y, bw, bh - 1); }
      const mw = 70 - n * 6, mx = cx - mw / 2 + Math.sin(t * 2.2) * w * .3, my = h - 6 - (n + 1) * bh;
      c.save(); c.shadowColor = col; c.shadowBlur = 10; c.fillStyle = col; c.fillRect(mx, my, mw, bh - 1); c.restore();
      c.fillStyle = 'rgba(255,255,255,.35)'; for (let i = 0; i < 8; i++) c.fillRect((i * 41) % w, (i * 29 + t * 8) % (h * .6), 1.5, 1.5);
    },
    memory(c, w, h, t, col) {
      // 3×3 のパッドが順番に光る
      const cols = ['#ff4d8d', '#ff9f43', '#ffd36e', '#5cff8d', '#5ee7ff', '#8ea7ff', '#b06bff', '#ff6bd6', '#fff'];
      const s = Math.min(w / 3.6, h / 3.6), gx = w / 2 - s * 1.5 - 4, gy = h / 2 - s * 1.5 - 4, lit = Math.floor(t * 1.8) % 9;
      for (let i = 0; i < 9; i++) { const x = gx + (i % 3) * (s + 4), y = gy + Math.floor(i / 3) * (s + 4); c.save(); c.shadowColor = cols[i]; c.shadowBlur = i === lit ? 14 : 0; c.fillStyle = i === lit ? cols[i] : 'rgba(255,255,255,.1)'; c.beginPath(); c.roundRect(x, y, s, s, s * .22); c.fill(); c.restore(); }
    },
    fps(c, w, h, t, col) {
      // 一人称の通路: 奥へ収束する床の線、迫るドローン（六角形）、照準
      const cx = w / 2, hz = h * 0.42;
      c.strokeStyle = 'rgba(94,231,255,.3)'; c.lineWidth = 1;
      for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(cx + i * 8, hz); c.lineTo(cx + i * w * 0.32, h); c.stroke(); }
      for (let i = 0; i < 6; i++) { const z = (i / 6 + (t * 0.25) % (1 / 6)) % 1, y = hz + (1 - z) * (1 - z) * (h - hz); c.globalAlpha = 0.6 * (1 - z) + 0.1; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
      c.globalAlpha = 1;
      [[0.3, -0.5, 0], [0.75, 0.6, 1.3], [0.55, -0.1, 2.6]].forEach(([zb, x, ph]) => { const z = ((zb + t * 0.18 + ph) % 1), s = 0.06 + (1 - z) * (1 - z) * 1.1, px = cx + x * s * w * 0.55, py = hz + s * h * 0.12, r = 4 + s * 16; c.save(); c.shadowColor = col; c.shadowBlur = 8; c.strokeStyle = col; c.lineWidth = 1.5; c.fillStyle = 'rgba(20,16,50,.9)'; c.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + t; c.lineTo(px + Math.cos(a) * r, py + Math.sin(a) * r); } c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#fff'; c.beginPath(); c.arc(px, py, r * 0.3, 0, 6.28); c.fill(); c.restore(); });
      const ax = cx + Math.sin(t * 1.1) * w * 0.12, ay = h * 0.5 + Math.cos(t * 0.9) * h * 0.1;
      c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(ax, ay, 9, 0, 6.28); c.stroke(); c.beginPath(); c.moveTo(ax - 13, ay); c.lineTo(ax - 5, ay); c.moveTo(ax + 5, ay); c.lineTo(ax + 13, ay); c.moveTo(ax, ay - 13); c.lineTo(ax, ay - 5); c.moveTo(ax, ay + 5); c.lineTo(ax, ay + 13); c.stroke();
    },
  };

  const TITLES = { rhythm: 'リズムスターズ', shooter: 'ギャラクシーブラスター', puzzle: 'ジュエルラッシュ', typing: 'タイピングバトル', racing: 'ネオンドライブ', runner: 'ダッシュ！ネコ忍者', mole: 'もぐらパニック', hockey: 'ネオンエアホッケー', quiz: '早押しクイズ王', breakout: 'ネオンブレイカー', duel: 'ネオンデュエル', stack: 'ネオンスタック', memory: 'メモリーフラッシュ', fps: 'ネオンストライク', drops: 'ネオンドロップバトル' };
  /** 模擬プレイ画面: 角丸の枠 ＋ 上部の小さな HUD ＋ 中にモチーフ。座標は呼び出し側の ctx の単位 */
  function drawScreen(c, id, x, y, w, h, t, col, opts) {
    opts = opts || {};
    const r = opts.radius == null ? Math.min(w, h) * 0.06 : opts.radius;
    const bar = opts.hud === false ? 0 : Math.max(18, h * 0.12);
    c.save();
    // 外枠の光
    if (opts.glow !== false) { c.shadowColor = col; c.shadowBlur = Math.min(w, h) * 0.12; c.fillStyle = 'rgba(0,0,0,0)'; c.beginPath(); c.roundRect(x, y, w, h, r); c.fillStyle = '#0a0a22'; c.fill(); c.shadowBlur = 0; }
    c.beginPath(); c.roundRect(x, y, w, h, r); c.fillStyle = '#07071a'; c.fill();
    c.strokeStyle = col; c.lineWidth = Math.max(1.5, Math.min(w, h) * 0.012); c.stroke();
    // 中身（クリップ）
    c.save(); c.beginPath(); c.roundRect(x, y, w, h, r); c.clip();
    c.translate(x, y + bar);
    c.beginPath(); c.rect(0, 0, w, h - bar); c.clip();
    // モチーフは幅 320px くらいを想定して描いてあるので、大きく出すときは拡大して描く（線や文字も太くなる）
    const k = Math.max(1, w / 400);
    c.scale(k, k);
    try { (PV[id] || PV.shooter)(c, w / k, (h - bar) / k, t, col); } catch (e) { /* 描けなくても枠は出す */ }
    c.restore();
    // HUD バー
    if (bar) {
      c.save(); c.beginPath(); c.roundRect(x, y, w, h, r); c.clip();
      c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(x, y, w, bar);
      c.fillStyle = col; c.globalAlpha = .8; c.fillRect(x, y + bar - 2, w, 2); c.globalAlpha = 1;
      const fs = bar * 0.42;
      c.font = `900 ${fs}px "Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif`; c.textBaseline = 'middle';
      c.textAlign = 'left'; c.fillStyle = 'rgba(255,255,255,.65)'; c.fillText('SCORE', x + bar * 0.5, y + bar / 2);
      c.fillStyle = '#fff'; c.fillText(opts.score != null ? String(opts.score) : String(Math.floor((t * 1234) % 99999)).padStart(5, '0'), x + bar * 0.5 + fs * 3.6, y + bar / 2);
      c.textAlign = 'center'; c.fillStyle = col; c.fillText(opts.title != null ? opts.title : (TITLES[id] || ''), x + w / 2, y + bar / 2);
      c.textAlign = 'right'; c.fillStyle = 'rgba(255,255,255,.65)'; c.fillText(opts.right != null ? opts.right : '♥♥♥', x + w - bar * 0.5, y + bar / 2);
      c.restore();
    }
    // 走査線（うっすら）
    if (opts.scanlines !== false) {
      c.save(); c.beginPath(); c.roundRect(x, y, w, h, r); c.clip(); c.globalAlpha = .07; c.fillStyle = '#000';
      for (let yy = y; yy < y + h; yy += 4) c.fillRect(x, yy, w, 1);
      c.restore();
    }
    c.restore();
  }
  global.FES_PV = { motifs: PV, titles: TITLES, draw(id, c, w, h, t, col) { (PV[id] || PV.shooter)(c, w, h, t, col); }, drawScreen };
})(window);
