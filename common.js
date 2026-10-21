/* =====================================================================
   FES  —  文化祭ゲーム共通ライブラリ
   ---------------------------------------------------------------------
   全ゲームで共通に使う「効果音 / ランキング / リザルト画面 / ホームボタン /
   スタンプラリー / 演出ヘルパー（揺れ・ヒットストップ・パーティクル）/
   カウントダウン / ポーズ画面 / エラー時の自動復帰」。
   外部依存なし。オフラインでも動作する。

   使い方（最小）:
     FES.init({ id: 'rhythm', title: 'リズムスターズ' });
     FES.sfx('hit');                         // 効果音
     FES.showResult({ score: 12345, stats:[{label:'MAX COMBO', value:120}] },
                    () => restartGame());    // リザルト + ランキング登録

   演出ヘルパー（任意）:
     const fx = FES.fx();                    // ゲームごとに1つ作る
     fx.shake(1); fx.flash('#fff', .5); fx.hitStop(.06); fx.burst(x, y, { color:'#ffd36e' }); fx.text(x, y, '+100');
     // ループ内:  const d = fx.update(dt);  fx.begin(ctx);  …描画…  fx.draw(ctx);  fx.end(ctx);  fx.drawFlash(ctx, W, H);
   ===================================================================== */
(function (global) {
  'use strict';

  const FES = {};
  let cfg = { id: 'game', title: 'GAME', ranking: true };
  // 運営への不具合・要望の窓口（ゲームフィードバックセンター）
  const FEEDBACK_URL = 'https://game-feedback.brainrot-rumble.workers.dev/?game=bunkasai-game-center&lang=ja';
  FES.feedbackUrl = FEEDBACK_URL;

  /* ------------------------------------------------------------ 保存 */
  // 動作チェック（動作チェック/全ゲームチェック.html が ?fescheck=1 を付けて開く）のときは、記録・スタンプ・殿堂を
  // このページの中だけに置いて、PC のランキングや共有サーバーには残さない（部屋の PC で回してもテスト記録が出ない）
  const TEST = /[?&]fescheck=1(&|$)/.test(global.location ? global.location.search : '');
  FES.isTestRun = () => TEST;
  const mem = new Map();
  const LS = {
    get(k, d) { if (TEST && mem.has(k)) return JSON.parse(mem.get(k)); try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { if (TEST) { mem.set(k, JSON.stringify(v)); return; } try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const rankKey = id => `fes:${id}:ranking`;

  /* ------------------------------------------------------------ 共有ランキング（部屋の PC） */
  // setup.html でルームキーを登録した PC は「部屋の PC」。ランキングと殿堂をサーバーで共有する。
  // それ以外（お客さんのスマホなど）は今まで通り、その端末の中だけに保存する。
  // サーバーにつながらないときも止まらない: 手元のキャッシュで表示し、送れなかった記録は後で送り直す。
  const DEFAULT_API = 'https://neon-festa-api.brainrot-rumble.workers.dev';
  const ROOM_KEY = 'fes:room', CLOUD_KEY = 'fes:cloud', QUEUE_KEY = 'fes:cloud:queue';
  const room = LS.get(ROOM_KEY, null);                 // { key, pc, api? }
  const apiBase = () => (room && room.api) || DEFAULT_API;
  FES.isRoomPC = () => !!(room && room.key);
  FES.roomInfo = () => room ? { pc: room.pc, api: apiBase() } : null;
  const cloud = () => LS.get(CLOUD_KEY, { rankings: {}, hall: [], at: 0 });
  function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (room && room.key) headers['X-Room-Key'] = room.key;
    const ctl = global.AbortController ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 8000);
    return fetch(apiBase() + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctl && ctl.signal })
      .then(r => r.json().then(j => { if (!r.ok) { const e = new Error(j.error || r.status); e.status = r.status; throw e; } return j; }))
      .finally(() => timer && clearTimeout(timer));
  }
  FES.api = api;
  // 送り直す価値のある失敗: 通信エラー・連打制限・サーバーエラー・ルームキー違い（キーを登録し直せば送れる）。それ以外の 400 系は捨てる
  const retryable = e => !e.status || e.status === 429 || e.status === 401 || e.status === 403 || e.status >= 500;
  /** 送れなかった記録を送り直す。サーバーの連打制限（同じPCから10秒に3件）に引っかからないよう、1回の同期で2件まで */
  async function flushQueue() {
    if (TEST) return;
    for (let i = 0; i < 2; i++) {
      const q = LS.get(QUEUE_KEY, []);
      if (!q.length) return;
      const item = q[0];
      try { await api(item.path, { method: 'POST', body: item.body }); }
      catch (e) { if (retryable(e)) return; }   // 次の同期でまた送る
      LS.set(QUEUE_KEY, LS.get(QUEUE_KEY, []).slice(1));
    }
  }
  function postOrQueue(path, body) {
    if (TEST) return;
    api(path, { method: 'POST', body }).catch(e => {
      if (!retryable(e)) return;
      const q = LS.get(QUEUE_KEY, []); q.push({ path, body }); LS.set(QUEUE_KEY, q.slice(-200));
    });
  }
  /** サーバーから最新のランキングと殿堂を取ってくる。終わると window に 'fes:sync' イベント */
  FES.sync = async function () {
    if (!FES.isRoomPC()) return false;
    await flushQueue();
    try {
      const [rankings, hall] = await Promise.all([api('/api/rankings'), api('/api/hall')]);
      LS.set(CLOUD_KEY, { rankings, hall, at: Date.now() });
      global.dispatchEvent(new Event('fes:sync'));
      return true;
    } catch (e) { return false; }
  };
  FES.lastSync = () => cloud().at;

  FES.getRanking = function (id) {
    id = id || cfg.id;
    if (FES.isRoomPC()) return (cloud().rankings[id] || []).slice();
    return LS.get(rankKey(id), []);
  };
  FES.getHiScore = function (id) {
    const r = FES.getRanking(id);
    return r.length ? r[0].score : 0;
  };
  FES.saveScore = function (name, score, id) {
    id = id || cfg.id;
    const r = FES.getRanking(id);
    const entry = { name: String(name || '???').slice(0, 8), score: Math.floor(score), date: Date.now() };
    r.push(entry);
    r.sort((a, b) => b.score - a.score || a.date - b.date);
    const top = r.slice(0, 10);
    if (FES.isRoomPC()) {
      // 画面にはすぐ反映（手元のキャッシュに入れる）して、サーバーへは後ろで送る
      const c = cloud(); c.rankings[id] = top; LS.set(CLOUD_KEY, c);
      postOrQueue('/api/scores', { game: id, name: entry.name, score: entry.score, pc: room.pc });
    } else {
      LS.set(rankKey(id), top);
    }
    return top;
  };
  FES.isRankIn = function (score, id) {
    const r = FES.getRanking(id);
    return score > 0 && (r.length < 10 || score > r[r.length - 1].score);
  };
  FES.lastName = () => LS.get('fes:lastName', '');

  /* ------------------------------------------------------------ ゲーム一覧（ホームが登録する） */
  // リザルト画面の「スタンプの進み具合」「つぎのおすすめ」に使う。[{ id, title, icon, accent }]
  const GAMES_KEY = 'fes:games';
  FES.setGames = list => LS.set(GAMES_KEY, (list || []).map(g => ({ id: g.id, title: g.title, icon: g.icon, accent: g.accent })));
  FES.games = () => LS.get(GAMES_KEY, []);

  /* ------------------------------------------------------------ 名前（色＋どうぶつ） */
  // 名前は今のスタンプカードに結びつける。「次の人」で新しいカードになると名前もリセットされる。
  FES.NAME_COLORS = ['あか', 'あお', 'きいろ', 'みどり', 'ピンク', 'むらさき', 'オレンジ', 'しろ', 'くろ', 'きん'];
  FES.NAME_ANIMALS = ['ネコ', 'イヌ', 'ウサギ', 'クマ', 'パンダ', 'キツネ', 'ペンギン', 'ライオン', 'イルカ', 'ドラゴン'];
  const COLOR_HEX = { 'あか': '#ff5e5e', 'あお': '#4f8cff', 'きいろ': '#ffd36e', 'みどり': '#5cff8d', 'ピンク': '#ff7ab8', 'むらさき': '#b06bff', 'オレンジ': '#ff9f43', 'しろ': '#f4f4ff', 'くろ': '#5a5a7a', 'きん': '#f5c242' };
  const ANIMAL_EMOJI = { 'ネコ': '🐱', 'イヌ': '🐶', 'ウサギ': '🐰', 'クマ': '🐻', 'パンダ': '🐼', 'キツネ': '🦊', 'ペンギン': '🐧', 'ライオン': '🦁', 'イルカ': '🐬', 'ドラゴン': '🐲' };
  FES.randomName = () => FES.pick(FES.NAME_COLORS) + FES.pick(FES.NAME_ANIMALS);
  FES.currentName = function () { const c = FES.stampCard(); return (c && c.name) || ''; };
  FES.setCurrentName = function (name) { FES.renameStampCard(name); LS.set('fes:lastName', name); };
  /** 名前えらび UI。 戻り値 { el, value() }。 initial が色＋どうぶつなら、それを選んだ状態で始まる */
  FES.namePicker = function (initial) {
    ensureUI();
    let color = FES.NAME_COLORS.find(c => initial && initial.startsWith(c) && FES.NAME_ANIMALS.includes(initial.slice(c.length)));
    let animal = color ? initial.slice(color.length) : null;
    if (!color) { const r = FES.randomName(); color = FES.NAME_COLORS.find(c => r.startsWith(c)); animal = r.slice(color.length); }
    const show = el('div', { class: 'fes-pick-name' });
    const row = (list, get, set, deco) => {
      const r = el('div', { class: 'fes-pick-row' });
      list.forEach(v => {
        const b = el('button', { class: 'fes-chip', type: 'button', onclick: () => { set(v); FES.sfx('select'); sync(); } });
        deco(b, v);
        r.appendChild(b);
      });
      r.sync = () => r.querySelectorAll('.fes-chip').forEach(b => b.classList.toggle('on', b.dataset.v === get()));
      return r;
    };
    const cRow = row(FES.NAME_COLORS, () => color, v => color = v, (b, v) => { b.dataset.v = v; b.appendChild(el('i', { class: 'fes-dot', style: `background:${COLOR_HEX[v]}` })); b.appendChild(document.createTextNode(v)); });
    const aRow = row(FES.NAME_ANIMALS, () => animal, v => animal = v, (b, v) => { b.dataset.v = v; b.textContent = `${ANIMAL_EMOJI[v] || ''} ${v}`; });
    const omakase = el('button', { class: 'fes-chip omakase', type: 'button', text: '🎲 おまかせ', onclick: () => {
      const r = FES.randomName(); color = FES.NAME_COLORS.find(c => r.startsWith(c)); animal = r.slice(color.length); FES.sfx('select'); sync();
      show.classList.remove('bump'); void show.offsetWidth; show.classList.add('bump');
    } });
    function sync() {
      show.textContent = `${ANIMAL_EMOJI[animal] || ''} ${color}${animal}`;
      show.style.color = COLOR_HEX[color] || '#ffd36e';
      cRow.sync(); aRow.sync();
    }
    const wrap = el('div', { class: 'fes-pick' }, [
      el('div', { class: 'fes-pick-lbl', text: 'なまえを えらんでね' }), show,
      el('div', { class: 'fes-pick-lbl', text: 'いろ' }), cRow,
      el('div', { class: 'fes-pick-lbl', text: 'どうぶつ' }), aRow,
      el('div', { class: 'fes-pick-row' }, [omakase]),
    ]);
    sync();
    return { el: wrap, value: () => color + animal };
  };
  /** ランキングの保存先IDを切り替える（難易度別ランキングなどに使う）。例: FES.setId('rhythm_hard') */
  FES.setId = function (id) { if (id) cfg.id = String(id); return cfg.id; };
  FES.getId = () => cfg.id;

  /* ------------------------------------------------------------ 音 */
  let actx = null;
  let master = null;
  let muted = LS.get('fes:muted', false);
  const VOL = 0.5;

  function ensureAudio() {
    if (!actx) {
      try {
        actx = new (global.AudioContext || global.webkitAudioContext)();
        // master → コンプレッサー → 出力。音が重なっても割れないようにする
        master = actx.createGain();
        master.gain.value = muted ? 0 : VOL;
        let out = actx.destination;
        try {
          const comp = actx.createDynamicsCompressor();
          comp.threshold.value = -14; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;
          comp.connect(actx.destination); out = comp;
        } catch (e) { /* 古いブラウザ: コンプレッサーなしで鳴らす */ }
        master.connect(out);
      } catch (e) { return null; }
    }
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  FES.audioContext = () => ensureAudio();
  FES.unlockAudio = ensureAudio;
  FES.setMuted = function (m) {
    muted = !!m; LS.set('fes:muted', muted);
    if (master) master.gain.value = muted ? 0 : VOL;
    const b = document.getElementById('fes-mute'); if (b) b.textContent = muted ? '🔇' : '🔊';
  };
  FES.isMuted = () => muted;
  /** スマホの振動（対応端末のみ。音と一緒に使うと手触りが良くなる） */
  // ブラウザは最初の操作より前の vibrate をエラーにするので、1回でも触ってから
  let interacted = false;
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => global.addEventListener(ev, () => { interacted = true; }, { capture: true, passive: true, once: true }));
  FES.vibrate = function (ms) { if (!interacted) return; try { if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(ms || 15); } catch (e) {} };

  /**
   * 汎用トーン。 FES.tone({freq:440, dur:0.1, type:'square', vol:0.3, slide:880, attack:0.005, delay:0})
   */
  FES.tone = function (o) {
    const ac = ensureAudio(); if (!ac || muted) return;
    o = o || {};
    const t0 = ac.currentTime + (o.delay || 0);
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.freq || 440, t0);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slide), t0 + (o.dur || 0.1));
    const vol = o.vol == null ? 0.25 : o.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (o.dur || 0.1));
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + (o.dur || 0.1) + 0.05);
  };
  /** ノイズ（爆発・ヒット用） */
  let noiseBuf = null;
  FES.noise = function (o) {
    const ac = ensureAudio(); if (!ac || muted) return;
    o = o || {};
    const dur = o.dur || 0.2;
    const t0 = ac.currentTime + (o.delay || 0);
    if (!noiseBuf) {   // 1秒ぶんのノイズを1回だけ作って使い回す（毎回作ると重い）
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ac.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ac.createBiquadFilter(); f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.slide), t0 + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(o.vol == null ? 0.3 : o.vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  };

  /** プリセット効果音（名前は今までと同じ。中身を少し豪華に） */
  const SFX = {
    select:   () => FES.tone({ freq: 880, dur: 0.06, type: 'square', vol: 0.15 }),
    click:    () => { FES.tone({ freq: 1200, dur: 0.03, type: 'square', vol: 0.1 }); FES.noise({ dur: 0.03, freq: 4000, vol: 0.06, filter: 'highpass' }); },
    start:    () => { [523, 659, 784, 1047].forEach((f, i) => FES.tone({ freq: f, dur: 0.12, delay: i * 0.08, type: 'square', vol: 0.2 })); FES.noise({ dur: 0.25, freq: 3000, slide: 300, vol: 0.08, delay: 0.3 }); },
    hit:      () => { FES.tone({ freq: 660, slide: 990, dur: 0.07, type: 'triangle', vol: 0.3 }); FES.noise({ dur: 0.05, freq: 2500, slide: 600, vol: 0.12 }); },
    perfect:  () => { FES.tone({ freq: 1320, dur: 0.08, type: 'sine', vol: 0.3 }); FES.tone({ freq: 1760, dur: 0.12, delay: 0.04, type: 'sine', vol: 0.2 }); FES.tone({ freq: 2640, dur: 0.1, delay: 0.08, type: 'sine', vol: 0.1 }); },
    miss:     () => { FES.tone({ freq: 220, slide: 110, dur: 0.18, type: 'sawtooth', vol: 0.2 }); FES.noise({ dur: 0.12, freq: 500, slide: 100, vol: 0.1 }); },
    coin:     () => { FES.tone({ freq: 988, dur: 0.06, type: 'square', vol: 0.2 }); FES.tone({ freq: 1319, dur: 0.18, delay: 0.06, type: 'square', vol: 0.2 }); },
    jump:     () => FES.tone({ freq: 300, slide: 700, dur: 0.15, type: 'square', vol: 0.2 }),
    explode:  () => { FES.noise({ dur: 0.45, freq: 900, slide: 60, vol: 0.45 }); FES.tone({ freq: 90, slide: 30, dur: 0.4, type: 'sine', vol: 0.45 }); FES.noise({ dur: 0.08, freq: 4000, vol: 0.2, filter: 'highpass' }); },
    shoot:    () => FES.tone({ freq: 1200, slide: 300, dur: 0.08, type: 'sawtooth', vol: 0.12 }),
    powerup:  () => { [440, 554, 659, 880, 1108].forEach((f, i) => FES.tone({ freq: f, dur: 0.1, delay: i * 0.05, type: 'triangle', vol: 0.22 })); FES.tone({ freq: 1760, dur: 0.3, delay: 0.25, type: 'sine', vol: 0.12 }); },
    combo:    () => { FES.tone({ freq: 1047, dur: 0.05, type: 'square', vol: 0.15 }); FES.tone({ freq: 1568, dur: 0.1, delay: 0.05, type: 'square', vol: 0.15 }); },
    bounce:   () => { FES.tone({ freq: 500, slide: 350, dur: 0.06, type: 'triangle', vol: 0.25 }); FES.noise({ dur: 0.03, freq: 1500, vol: 0.08 }); },
    gameover: () => { [523, 494, 440, 392, 349].forEach((f, i) => FES.tone({ freq: f, dur: 0.25, delay: i * 0.18, type: 'triangle', vol: 0.25 })); FES.tone({ freq: 175, dur: 0.6, delay: 0.72, type: 'sine', vol: 0.2 }); },
    fanfare:  () => { [523, 523, 523, 659, 784, 1047].forEach((f, i) => { FES.tone({ freq: f, dur: i === 5 ? 0.6 : 0.14, delay: [0, .15, .3, .45, .6, .8][i], type: 'square', vol: 0.22 }); FES.tone({ freq: f / 2, dur: i === 5 ? 0.6 : 0.14, delay: [0, .15, .3, .45, .6, .8][i], type: 'triangle', vol: 0.12 }); }); FES.noise({ dur: 0.5, freq: 5000, slide: 500, vol: 0.1, delay: 0.8, filter: 'highpass' }); },
    tick:     () => FES.tone({ freq: 1500, dur: 0.03, type: 'square', vol: 0.08 }),
    countdown:() => FES.tone({ freq: 660, dur: 0.15, type: 'square', vol: 0.25 }),
    go:       () => { FES.tone({ freq: 1320, dur: 0.4, type: 'square', vol: 0.3 }); FES.tone({ freq: 660, dur: 0.4, type: 'triangle', vol: 0.15 }); FES.noise({ dur: 0.3, freq: 3000, slide: 400, vol: 0.1 }); },
    wrong:    () => { FES.tone({ freq: 200, dur: 0.15, type: 'square', vol: 0.25 }); FES.tone({ freq: 160, dur: 0.25, delay: 0.15, type: 'square', vol: 0.25 }); },
    correct:  () => { FES.tone({ freq: 1047, dur: 0.1, type: 'sine', vol: 0.3 }); FES.tone({ freq: 1568, dur: 0.25, delay: 0.1, type: 'sine', vol: 0.3 }); },
    stamp:    () => { FES.noise({ dur: 0.12, freq: 600, slide: 80, vol: 0.4 }); FES.tone({ freq: 160, slide: 60, dur: 0.15, type: 'sine', vol: 0.4 }); FES.tone({ freq: 1568, dur: 0.12, delay: 0.1, type: 'sine', vol: 0.15 }); },
    rankin:   () => { [784, 988, 1175, 1568].forEach((f, i) => FES.tone({ freq: f, dur: 0.14, delay: i * 0.07, type: 'square', vol: 0.18 })); FES.tone({ freq: 2093, dur: 0.5, delay: 0.3, type: 'sine', vol: 0.15 }); },
    whoosh:   () => FES.noise({ dur: 0.25, freq: 300, slide: 3000, vol: 0.15, filter: 'bandpass' }),
    levelup:  () => { [523, 659, 784, 1047, 1319].forEach((f, i) => FES.tone({ freq: f, dur: 0.12, delay: i * 0.06, type: 'triangle', vol: 0.2 })); },
  };
  SFX.gradeS = () => { [0, 4, 7, 12, 16, 19, 24].forEach((n, i) => FES.tone({ freq: 523 * Math.pow(2, n / 12), dur: 0.5, delay: i * 0.06, type: 'triangle', vol: 0.18 })); FES.noise({ dur: 0.5, freq: 3000, slide: 600, vol: 0.12, delay: 0.3 }); };
  SFX.gradeA = () => { [0, 4, 7, 12].forEach((n, i) => FES.tone({ freq: 523 * Math.pow(2, n / 12), dur: 0.35, delay: i * 0.07, type: 'triangle', vol: 0.18 })); };
  SFX.gradeB = () => { [0, 4, 7].forEach((n, i) => FES.tone({ freq: 440 * Math.pow(2, n / 12), dur: 0.3, delay: i * 0.08, type: 'triangle', vol: 0.16 })); };
  SFX.gradeC = () => { FES.tone({ freq: 440, dur: 0.25, type: 'triangle', vol: 0.15 }); FES.tone({ freq: 554, dur: 0.3, delay: 0.1, type: 'triangle', vol: 0.15 }); };
  SFX.gradeD = () => { FES.tone({ freq: 330, dur: 0.3, type: 'triangle', vol: 0.12 }); FES.tone({ freq: 294, dur: 0.4, delay: 0.14, type: 'triangle', vol: 0.12 }); };
  SFX.fever = () => { [0, 7, 12, 19, 24].forEach((n, i) => FES.tone({ freq: 392 * Math.pow(2, n / 12), dur: 0.18, delay: i * 0.05, type: 'square', vol: 0.1 })); FES.noise({ dur: 0.35, freq: 2500, slide: 300, vol: 0.15 }); };
  FES.sfx = function (name) { const f = SFX[name]; if (f) f(); };

  /* ------------------------------------------------------------ ランク評価（S/A/B/C/D）と称号 */
  const GRADES = ['S', 'A', 'B', 'C', 'D'];
  const GRADE_TITLE = { S: '神ってる！', A: '達人！', B: '上手！', C: 'いい感じ', D: 'つぎはもっと！' };
  const GRADE_COLOR = { S: '#ffd36e', A: '#ff4d8d', B: '#5ee7ff', C: '#5cff8d', D: '#b8b8c8' };
  /** 点数としきい値 {S,A,B,C} からランクを決める。しきい値以上でそのランク */
  FES.grade = function (score, bands) {
    if (!bands) return null;
    for (const g of ['S', 'A', 'B', 'C']) if (bands[g] != null && score >= bands[g]) return g;
    return 'D';
  };
  FES.gradeTitle = (g, titles) => (titles && titles[g]) || GRADE_TITLE[g] || '';
  FES.gradeColor = g => GRADE_COLOR[g] || '#fff';
  FES.gradeIndex = g => GRADES.indexOf(g);   // 小さいほど上
  const GRADES_KEY = 'fes:grades';
  FES.bestGrades = () => LS.get(GRADES_KEY, {});           // { gameId: 'S' }
  FES.bestGrade = id => FES.bestGrades()[id] || null;
  FES.saveGrade = function (id, g) {
    if (!g || !GRADES.includes(g)) return { grade: g, improved: false };
    const all = FES.bestGrades(); const cur = all[id];
    const improved = !cur || FES.gradeIndex(g) < FES.gradeIndex(cur);
    if (improved) { all[id] = g; LS.set(GRADES_KEY, all); }
    return { grade: g, improved, prev: cur || null };
  };

  /* ------------------------------------------------------------ フィーバー演出（画面ふちの虹色の光。DOM なのでどのゲームからも1行で使える） */
  let feverEl = null, feverLbl = null, feverOn = false;
  /** FES.fever(true, 'FEVER!') / FES.fever(false) */
  FES.fever = function (on, label) {
    ensureUI();
    if (on && !feverOn) {
      feverOn = true;
      feverEl = el('div', { class: 'fes-fever' });
      ui.appendChild(feverEl);
      if (label !== null) { feverLbl = el('div', { class: 'fes-fever-lbl', text: label || 'FEVER!' }); ui.appendChild(feverLbl); setTimeout(() => { if (feverLbl) { feverLbl.remove(); feverLbl = null; } }, 1400); }
      FES.sfx('fever'); FES.vibrate([20, 30, 20]);
    } else if (!on && feverOn) {
      feverOn = false;
      const e = feverEl; feverEl = null; if (e) { e.classList.add('out'); setTimeout(() => e.remove(), 500); }
      if (feverLbl) { feverLbl.remove(); feverLbl = null; }
    }
  };
  FES.isFever = () => feverOn;

  /* ------------------------------------------------------------ 軽量モード（古い PC 向け: 粒子・紙吹雪・フィーバーの負荷を下げる） */
  const LITE_KEY = 'fes:lite';
  FES.lite = () => !!LS.get(LITE_KEY, false);
  FES.setLite = v => { LS.set(LITE_KEY, !!v); document.documentElement.classList.toggle('fes-lite', !!v); };

  /* ------------------------------------------------------------ 画面切り替えのワイプ（ページを開いたとき暗から明へ／リンクで出るとき明から暗へ） */
  let wipeEl = null;
  function accentColor() {
    if (cfg.accent) return cfg.accent;
    const g = FES.games().find(x => x.id === FES.stampBase(cfg.id));
    return (g && g.accent) || '#7a5cff';
  }
  FES.wipeIn = function () {
    ensureUI(); if (wipeEl) wipeEl.remove();
    wipeEl = el('div', { class: 'fes-wipe out', style: `--wc:${accentColor()}` });
    ui.appendChild(wipeEl);
    const me = wipeEl; setTimeout(() => { me.remove(); if (wipeEl === me) wipeEl = null; }, 700);
  };
  /** リンク先へ、暗転してから移動する */
  FES.leaveTo = function (href) {
    ensureUI(); if (wipeEl) wipeEl.remove();
    wipeEl = el('div', { class: 'fes-wipe in', style: `--wc:${accentColor()}` });
    ui.appendChild(wipeEl);
    setTimeout(() => { location.href = href; }, 230);
  };

  /* ------------------------------------------------------------ あそびかたチップ（ゲーム開始のカウントダウン中に数秒だけ出す） */
  let howtoEl = null, howtoTm = null;
  /** FES.howto(['🔨 クリックでたたく', '⭐ 金もぐら +500']) / FES.howto(false) で消す */
  FES.howto = function (hints, ms) {
    ensureUI();
    clearTimeout(howtoTm);
    if (howtoEl) { howtoEl.remove(); howtoEl = null; }
    if (hints === false || !hints || !hints.length) return;
    howtoEl = el('div', { class: 'fes-howto' }, [el('div', { class: 'lbl', text: 'あそびかた' })].concat(hints.map((h, i) => el('div', { class: 'chip', style: `animation-delay:${0.12 + i * 0.13}s`, text: h }))));
    ui.appendChild(howtoEl);
    const me = howtoEl;
    howtoTm = setTimeout(() => { me.classList.add('out'); setTimeout(() => me.remove(), 450); if (howtoEl === me) howtoEl = null; }, ms || 4500);
  };
  FES.sfxNames = Object.keys(SFX);

  /* ------------------------------------------------------------ 演出ヘルパー（Canvas 用） */
  /**
   * fx = FES.fx()
   *   fx.shake(power=1, dur=0.3)      画面揺れ
   *   fx.flash(color='#fff', a=0.5, dur=0.12)  画面フラッシュ
   *   fx.hitStop(sec=0.06)           一瞬止める（update が 0 を返す）
   *   fx.burst(x, y, { color, n, speed, life, size, gravity, shape:'circle'|'rect'|'spark'|'star' })
   *   fx.ring(x, y, { color, r, life })   広がる輪
   *   fx.text(x, y, '+100', { color, size, life, vy })   浮かぶ文字
   *   dt2 = fx.update(dt)             毎フレーム最初に。ヒットストップ中は 0
   *   fx.begin(ctx) / fx.end(ctx)     揺れぶん translate する（間に描画）
   *   fx.draw(ctx)                    パーティクルと文字を描く（begin〜end の間で）
   *   fx.drawFlash(ctx, W, H)         フラッシュを描く（end のあと）
   *   fx.clear()                      全部消す（リトライ時）
   */
  FES.fx = function () {
    const s = { shake: 0, shakeDur: 0.3, sx: 0, sy: 0, flashA: 0, flashColor: '#fff', flashDur: 0.12, flashT: 0, stop: 0, parts: [], texts: [], rings: [], t: 0 };
    const fx = {
      shake(power, dur) { s.shake = Math.max(s.shake, power == null ? 1 : power); s.shakeDur = dur || 0.3; },
      flash(color, a, dur) { s.flashColor = color || '#fff'; s.flashA = a == null ? 0.5 : a; s.flashDur = dur || 0.12; s.flashT = s.flashDur; },
      hitStop(sec) { s.stop = Math.max(s.stop, sec == null ? 0.06 : sec); },
      burst(x, y, o) {
        o = o || {};
        const lite = FES.lite();
        const n = Math.max(1, Math.round((o.n || 18) * (lite ? 0.45 : 1))), speed = o.speed || 220, life = o.life || 0.6, size = o.size || 5, g = o.gravity == null ? 300 : o.gravity;
        const colors = Array.isArray(o.color) ? o.color : [o.color || '#ffd36e'];
        for (let i = 0; i < n; i++) {
          const a = (o.angle != null ? o.angle + (Math.random() - .5) * (o.spread == null ? Math.PI * 2 : o.spread) : Math.random() * Math.PI * 2);
          const sp = speed * (0.35 + Math.random() * 0.85);
          s.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: life * (0.6 + Math.random() * 0.6), max: life, size: size * (0.6 + Math.random() * 0.8),
            color: colors[(Math.random() * colors.length) | 0], g, shape: o.shape || 'circle', rot: Math.random() * Math.PI * 2, vr: (Math.random() - .5) * 12, drag: o.drag == null ? 0.9 : o.drag });
        }
        const cap = lite ? 220 : 600; if (s.parts.length > cap) s.parts.splice(0, s.parts.length - cap);
      },
      ring(x, y, o) { o = o || {}; s.rings.push({ x, y, r: o.r || 10, r1: o.r1 || 120, life: o.life || 0.4, max: o.life || 0.4, color: o.color || '#fff', w: o.width || 4 }); },
      text(x, y, str, o) { o = o || {}; s.texts.push({ x, y, str: String(str), life: o.life || 0.8, max: o.life || 0.8, color: o.color || '#fff', size: o.size || 22, vy: o.vy == null ? -70 : o.vy, vx: o.vx || 0, weight: o.weight || 900, stroke: o.stroke !== false }); if (s.texts.length > 60) s.texts.shift(); },
      update(dt) {
        dt = Math.min(dt || 0, 0.05);
        s.t += dt;
        if (s.stop > 0) { s.stop -= dt; return 0; }
        if (s.shake > 0) {
          s.shake = Math.max(0, s.shake - dt / s.shakeDur);
          const k = s.shake * s.shake * 14;
          s.sx = (Math.random() - .5) * 2 * k; s.sy = (Math.random() - .5) * 2 * k;
        } else { s.sx = s.sy = 0; }
        if (s.flashT > 0) s.flashT -= dt;
        for (let i = s.parts.length - 1; i >= 0; i--) {
          const p = s.parts[i];
          p.life -= dt; if (p.life <= 0) { s.parts.splice(i, 1); continue; }
          p.vy += p.g * dt; const d = Math.pow(p.drag, dt * 60); p.vx *= d; p.vy *= d;
          p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        }
        for (let i = s.rings.length - 1; i >= 0; i--) { const r = s.rings[i]; r.life -= dt; if (r.life <= 0) s.rings.splice(i, 1); }
        for (let i = s.texts.length - 1; i >= 0; i--) { const t = s.texts[i]; t.life -= dt; if (t.life <= 0) { s.texts.splice(i, 1); continue; } t.y += t.vy * dt; t.x += t.vx * dt; t.vy *= Math.pow(0.9, dt * 60); }
        return dt;
      },
      begin(ctx) { ctx.save(); if (s.sx || s.sy) ctx.translate(s.sx, s.sy); },
      end(ctx) { ctx.restore(); },
      draw(ctx) {
        ctx.save();
        for (const p of s.parts) {
          const k = Math.max(0, p.life / p.max);
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.fillStyle = p.color;
          const sz = p.size * (0.3 + k * 0.7);
          if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(p.x, p.y, sz, 0, Math.PI * 2); ctx.fill(); }
          else if (p.shape === 'spark') { ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(1, sz * 0.5); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke(); }
          else {
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            if (p.shape === 'star') { ctx.beginPath(); for (let i = 0; i < 10; i++) { const r = i % 2 ? sz * 0.5 : sz * 1.2, a = i * Math.PI / 5; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.fill(); }
            else ctx.fillRect(-sz, -sz * 0.6, sz * 2, sz * 1.2);
            ctx.restore();
          }
        }
        for (const r of s.rings) {
          const k = 1 - r.life / r.max;
          ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = r.color; ctx.lineWidth = r.w * (1 - k * 0.7);
          ctx.beginPath(); ctx.arc(r.x, r.y, r.r + (r.r1 - r.r) * (1 - Math.pow(1 - k, 3)), 0, Math.PI * 2); ctx.stroke();
        }
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const t of s.texts) {
          const k = t.life / t.max, pop = 1 + Math.max(0, (k - 0.8) * 5) * 0.6;
          ctx.globalAlpha = Math.min(1, k * 2.5);
          ctx.font = `${t.weight} ${Math.round(t.size * pop)}px "Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif`;
          if (t.stroke) { ctx.lineWidth = Math.max(3, t.size * 0.18); ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineJoin = 'round'; ctx.strokeText(t.str, t.x, t.y); }
          ctx.fillStyle = t.color; ctx.fillText(t.str, t.x, t.y);
        }
        ctx.restore();
      },
      drawFlash(ctx, W, H) {
        if (s.flashT <= 0 || s.flashA <= 0) return;
        ctx.save(); ctx.globalAlpha = s.flashA * (s.flashT / s.flashDur); ctx.fillStyle = s.flashColor; ctx.fillRect(0, 0, W, H); ctx.restore();
      },
      clear() { s.parts.length = 0; s.texts.length = 0; s.rings.length = 0; s.shake = 0; s.flashT = 0; s.stop = 0; s.sx = s.sy = 0; },
      get shakeX() { return s.sx; }, get shakeY() { return s.sy; },
      get count() { return s.parts.length; },
    };
    return fx;
  };
  /** 数字をなめらかに増やす（DOM 要素 or 関数）。 FES.countUp(el, 0, 12345, 0.9) */
  FES.countUp = function (target, from, to, dur, done) {
    const t0 = performance.now(); dur = (dur || 0.8) * 1000;
    const set = typeof target === 'function' ? target : v => { target.textContent = Math.round(v).toLocaleString(); };
    let lastTick = 0;
    (function step(now) {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      set(from + (to - from) * e);
      if (p < 1) { if (now - lastTick > 55 && to !== from) { FES.tone({ freq: 900 + 700 * p, dur: 0.025, type: 'square', vol: 0.05 }); lastTick = now; } requestAnimationFrame(step); }
      else if (done) done();
    })(t0);
  };
  FES.easeOut = p => 1 - Math.pow(1 - p, 3);
  FES.easeBack = p => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };

  /* ------------------------------------------------------------ CSS */
  const CSS = `
  #fes-ui, #fes-ui * { box-sizing: border-box; font-family: "Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif; }
  #fes-ui { position: fixed; inset: 0; pointer-events: none; z-index: 9000; }
  .fes-btn { pointer-events: auto; position: fixed; top: 10px; width: 44px; height: 44px; border-radius: 12px; border: 1px solid rgba(255,255,255,.25);
    background: rgba(0,0,0,.45); color: #fff; font-size: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer;
    backdrop-filter: blur(6px); transition: transform .12s, background .12s; text-decoration: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .fes-btn:hover { transform: scale(1.08); background: rgba(255,255,255,.15); }
  .fes-btn:active { transform: scale(.94); }
  #fes-home { left: 10px; }
  #fes-mute { right: 64px; }
  #fes-full { right: 10px; }
  #fes-overlay, .fes-overlay { pointer-events: auto; position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(5,5,20,.72); backdrop-filter: blur(8px); animation: fesFade .35s ease-out; }
  @keyframes fesFade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes fesPop { 0% { transform: scale(.7) translateY(30px); opacity: 0 } 60% { transform: scale(1.04) translateY(-4px); opacity: 1 } 100% { transform: scale(1) translateY(0) } }
  @keyframes fesScore { from { transform: scale(2.2); opacity: 0 } to { transform: scale(1); opacity: 1 } }
  @keyframes fesShine { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
  @keyframes fesBump { 0% { transform: scale(1) } 40% { transform: scale(1.18) } 100% { transform: scale(1) } }
  @keyframes fesStamp { 0% { transform: scale(2.6) rotate(-25deg); opacity: 0 } 60% { transform: scale(.92) rotate(6deg); opacity: 1 } 100% { transform: scale(1) rotate(-6deg) } }
  @keyframes fesGlow { 0%,100% { box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 60px rgba(120,90,255,.25) } 50% { box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 90px rgba(255,211,110,.35) } }
  @keyframes fesCount { 0% { transform: scale(2.4); opacity: 0 } 25% { transform: scale(1); opacity: 1 } 80% { transform: scale(1); opacity: 1 } 100% { transform: scale(.6); opacity: 0 } }
  @keyframes fesGo { 0% { transform: scale(.4); opacity: 0 } 30% { transform: scale(1.15); opacity: 1 } 100% { transform: scale(1.4); opacity: 0 } }
  .fes-card { position: relative; width: min(92vw, 540px); max-height: 94vh; overflow: auto; border-radius: 26px; padding: 26px 26px 20px; color: #fff; text-align: center;
    background: linear-gradient(160deg, rgba(34,32,80,.96), rgba(10,10,30,.98)); border: 1px solid rgba(255,255,255,.18);
    box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 60px rgba(120,90,255,.25); animation: fesPop .5s cubic-bezier(.2,1.4,.4,1); scrollbar-width: thin; }
  .fes-card.rankin { animation: fesPop .5s cubic-bezier(.2,1.4,.4,1), fesGlow 2.4s ease-in-out .5s infinite; border-color: rgba(255,211,110,.45); }
  .fes-card h2 { margin: 0 0 4px; font-size: 13px; letter-spacing: .35em; opacity: .7; font-weight: 700; }
  .fes-card .fes-title { font-size: 28px; font-weight: 900; margin: 0 0 10px; letter-spacing: .05em; line-height: 1.2;
    background: linear-gradient(90deg,#fff,#ffd36e,#fff,#8ed6ff,#fff); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: fesShine 3s linear infinite; }
  .fes-score { font-size: 60px; font-weight: 900; line-height: 1.1; margin: 6px 0 6px; font-variant-numeric: tabular-nums; animation: fesScore .5s cubic-bezier(.2,1.4,.4,1) .1s both; text-shadow: 0 0 30px rgba(255,220,120,.6); }
  .fes-score.done { animation: fesBump .35s ease-out; }
  .fes-score small { font-size: 16px; opacity: .7; margin-left: 4px; }
  .fes-sub { opacity: .8; font-size: 14px; margin-bottom: 12px; }
  .fes-grade-wrap { display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 86px; margin: 2px 0 6px; flex-wrap: wrap; }
  .fes-grade { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; width: 84px; height: 84px; border-radius: 22px; border: 4px solid var(--gc, #fff);
    background: radial-gradient(circle at 30% 25%, rgba(255,255,255,.25), rgba(0,0,0,.35)); color: var(--gc, #fff); box-shadow: 0 0 30px color-mix(in srgb, var(--gc, #fff) 55%, transparent), inset 0 0 18px rgba(0,0,0,.4);
    animation: fesStamp .55s cubic-bezier(.2,1.3,.4,1) both; transform: rotate(-6deg); }
  .fes-grade .lbl { font-size: 10px; letter-spacing: .3em; font-weight: 800; opacity: .8; margin-bottom: -4px; }
  .fes-grade .g { font-size: 50px; font-weight: 900; line-height: 1; text-shadow: 0 0 18px color-mix(in srgb, var(--gc, #fff) 70%, transparent); }
  .fes-grade.gS { background: radial-gradient(circle at 30% 25%, rgba(255,255,255,.45), rgba(120,70,0,.5)); animation: fesStamp .55s cubic-bezier(.2,1.3,.4,1) both, fesGlowS 1.6s ease-in-out .6s infinite; }
  @keyframes fesGlowS { 0%,100% { box-shadow: 0 0 30px rgba(255,211,110,.6), inset 0 0 18px rgba(0,0,0,.4) } 50% { box-shadow: 0 0 60px rgba(255,211,110,.95), 0 0 120px rgba(255,180,60,.5), inset 0 0 18px rgba(0,0,0,.4) } }
  .fes-grade-title { font-size: 20px; font-weight: 900; letter-spacing: .04em; animation: fesFade .4s ease .35s both; text-shadow: 0 2px 10px rgba(0,0,0,.6); }
  .fes-fever { position: fixed; inset: 0; pointer-events: none; z-index: 8990; border-radius: 0; animation: fesFeverIn .35s ease both, fesFeverHue 2.2s linear infinite;
    box-shadow: inset 0 0 90px 34px rgba(255,80,160,.75), inset 0 0 200px 80px rgba(255,140,60,.35); mix-blend-mode: screen; }
  .fes-fever.out { animation: fesFeverOut .45s ease both; }
  .fes-fever::before { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(255,77,141,.18), rgba(255,211,110,.14), rgba(94,231,255,.18), rgba(176,107,255,.14), rgba(255,77,141,.18)); background-size: 300% 100%; animation: fesShine 1.4s linear infinite; mask: linear-gradient(#000, transparent 18%, transparent 82%, #000); -webkit-mask: linear-gradient(#000, transparent 18%, transparent 82%, #000); }
  @keyframes fesFeverIn { from { opacity: 0 } to { opacity: 1 } }
  @keyframes fesFeverOut { from { opacity: 1 } to { opacity: 0 } }
  @keyframes fesFeverHue { from { filter: hue-rotate(0deg) } to { filter: hue-rotate(360deg) } }
  .fes-fever-lbl { position: fixed; left: 50%; top: 22%; transform: translateX(-50%); z-index: 8995; pointer-events: none; font-size: clamp(40px, 8vw, 96px); font-weight: 900; letter-spacing: .08em; font-style: italic;
    background: linear-gradient(90deg, #ff4d8d, #ffd36e, #5ee7ff, #b06bff, #ff4d8d); background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 0 18px rgba(255,120,200,.8)) drop-shadow(0 4px 0 rgba(0,0,0,.6));
    animation: fesShine 1.2s linear infinite, fesFeverLbl 1.4s ease both; }
  @keyframes fesFeverLbl { 0% { opacity: 0; transform: translateX(-50%) scale(.4) } 20% { opacity: 1; transform: translateX(-50%) scale(1.15) } 35% { transform: translateX(-50%) scale(1) } 80% { opacity: 1 } 100% { opacity: 0; transform: translateX(-50%) scale(1.3) } }
  .fes-missions { display: flex; flex-wrap: wrap; gap: 6px 10px; justify-content: center; align-items: center; margin: 8px 0 2px; font-size: 12px; font-weight: 700; color: rgba(255,255,255,.75); }
  .fes-missions .lbl { color: #ffd36e; font-weight: 900; letter-spacing: .04em; }
  .fes-missions .m { padding: 3px 10px; border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); }
  .fes-missions .m.done { background: rgba(92,255,141,.14); border-color: rgba(92,255,141,.4); color: #b8ffd0; }
  .fes-badges { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
  .fes-badge { padding: 10px 14px; border-radius: 14px; background: linear-gradient(135deg, rgba(255,211,110,.22), rgba(255,77,141,.18)); border: 1px solid rgba(255,211,110,.5); text-align: left; animation: fesPop .5s cubic-bezier(.2,1.4,.4,1) 1s both; box-shadow: 0 0 24px rgba(255,211,110,.25); }
  .fes-badge b { display: block; font-size: 15px; color: #ffd36e; }
  .fes-badge span { font-size: 12px; color: rgba(255,255,255,.8); }
  .fes-badge.mission { background: linear-gradient(135deg, rgba(92,255,141,.2), rgba(94,231,255,.16)); border-color: rgba(92,255,141,.5); box-shadow: 0 0 24px rgba(92,255,141,.2); }
  .fes-badge.mission b { color: #8dffb5; }
  .fes-prize { margin: 10px 0 2px; padding: 10px 14px; border-radius: 14px; font-weight: 900; color: #2a2200; background: linear-gradient(90deg, #ffd36e, #ffb347); animation: fesBump 1.2s ease-in-out infinite; }
  .fes-howto { position: fixed; left: 50%; bottom: 9vh; transform: translateX(-50%); z-index: 8980; pointer-events: none; display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 8px; max-width: min(94vw, 900px); animation: fesFade .3s ease both; }
  .fes-howto.out { animation: fesFeverOut .4s ease both; }
  .fes-howto .lbl { width: 100%; text-align: center; font-size: 12px; letter-spacing: .3em; font-weight: 900; color: rgba(255,255,255,.7); text-shadow: 0 2px 8px rgba(0,0,0,.8); }
  .fes-howto .chip { padding: 9px 16px; border-radius: 999px; background: rgba(8,8,28,.86); border: 1px solid rgba(255,255,255,.28); color: #fff; font-weight: 900; font-size: clamp(14px, 2.2vw, 18px); box-shadow: 0 6px 24px rgba(0,0,0,.5); animation: fesPop .5s cubic-bezier(.2,1.4,.4,1) both; white-space: nowrap; }
  .fes-wipe { position: fixed; inset: 0; z-index: 9950; pointer-events: none; background: #07071a; }
  .fes-wipe.out { animation: fesWipeOut .45s ease both; }
  .fes-wipe.in { pointer-events: auto; animation: fesWipeIn .22s ease both; }
  @keyframes fesWipeOut { from { opacity: 1 } to { opacity: 0 } }
  @keyframes fesWipeIn { from { opacity: 0 } to { opacity: 1 } }
  .fes-lite .fes-fever { animation: fesFeverIn .35s ease both; }
  .fes-lite .fes-fever::before { display: none; }
  .fes-lite .fes-grade.gS { animation: fesStamp .55s cubic-bezier(.2,1.3,.4,1) both; }
  .fes-newrec { display: inline-block; margin: 4px 0 10px; padding: 5px 16px; border-radius: 999px; font-weight: 900; font-size: 14px; letter-spacing: .15em;
    background: linear-gradient(90deg,#ff4d8d,#ffb347); box-shadow: 0 0 24px rgba(255,120,80,.6); animation: fesPop .6s .3s both; }
  .fes-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px,1fr)); gap: 8px; margin: 10px 0 14px; }
  .fes-stat { background: rgba(255,255,255,.07); border-radius: 12px; padding: 8px 6px; }
  .fes-stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .fes-stat span { font-size: 11px; opacity: .65; letter-spacing: .1em; }
  /* スタンプの進み具合 */
  .fes-stamps { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin: 4px 0 12px; }
  .fes-stamp { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; font-size: 18px; background: rgba(255,255,255,.06); border: 2px dashed rgba(255,255,255,.22); filter: grayscale(1); opacity: .45; }
  .fes-stamp.on { filter: none; opacity: 1; border: 2px solid #fff; background: var(--c, #ff4d8d); box-shadow: 0 4px 12px rgba(0,0,0,.35); transform: rotate(-6deg); }
  .fes-stamp.new { animation: fesStamp .55s cubic-bezier(.2,1.2,.4,1) both; }
  .fes-stamp-lbl { font-size: 12px; opacity: .75; margin-bottom: 4px; letter-spacing: .1em; }
  .fes-stamp-lbl b { color: #ffd36e; }
  .fes-namebox { margin: 4px 0 14px; }
  .fes-pick { margin-bottom: 12px; }
  .fes-pick-lbl { font-size: 11px; letter-spacing: .2em; opacity: .6; margin: 8px 0 4px; }
  .fes-pick-name { font-size: 30px; font-weight: 900; margin: 2px 0 4px; color: #ffd36e; text-shadow: 0 0 18px rgba(0,0,0,.5); }
  .fes-pick-name.bump { animation: fesBump .3s ease-out; }
  .fes-pick-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .fes-chip { pointer-events: auto; padding: 7px 11px; min-height: 40px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08);
    color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; transition: transform .1s, background .1s; display: inline-flex; align-items: center; gap: 6px; -webkit-tap-highlight-color: transparent; }
  .fes-chip:hover { background: rgba(255,255,255,.18); }
  .fes-chip:active { transform: scale(.94); }
  .fes-chip.on { background: linear-gradient(135deg,#6a5cff,#b04dff); border-color: transparent; box-shadow: 0 4px 14px rgba(120,80,255,.5); transform: scale(1.06); }
  .fes-chip.omakase { margin-top: 8px; }
  .fes-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; box-shadow: 0 0 0 1px rgba(255,255,255,.5) inset; }
  .fes-rank { text-align: left; margin: 0 0 14px; padding: 0; list-style: none; max-height: 210px; overflow: auto; font-variant-numeric: tabular-nums; scrollbar-width: thin; }
  .fes-rank li { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-radius: 8px; font-size: 14px; }
  .fes-rank li:nth-child(odd) { background: rgba(255,255,255,.05); }
  .fes-rank li.me { background: linear-gradient(90deg, rgba(255,211,110,.35), rgba(255,77,141,.25)); font-weight: 900; box-shadow: 0 0 0 1px rgba(255,211,110,.5) inset; animation: fesBump .4s ease-out; }
  .fes-rank .r { width: 28px; font-weight: 900; opacity: .8; }
  .fes-rank .r.g1 { color: #ffd36e; } .fes-rank .r.g2 { color: #d9d9e6; } .fes-rank .r.g3 { color: #e8a26a; }
  .fes-rank .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fes-rank .s { font-weight: 700; }
  .fes-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .fes-act { pointer-events: auto; padding: 13px 26px; min-height: 48px; border-radius: 14px; border: 0; font-size: 16px; font-weight: 900; cursor: pointer; color: #fff; letter-spacing: .05em;
    background: linear-gradient(135deg,#6a5cff,#b04dff); box-shadow: 0 8px 24px rgba(120,80,255,.45); transition: transform .12s, filter .12s; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; -webkit-tap-highlight-color: transparent; }
  .fes-act.alt { background: rgba(255,255,255,.12); box-shadow: none; }
  .fes-act.next { background: linear-gradient(135deg,#ff4d8d,#ff9f43); box-shadow: 0 8px 24px rgba(255,100,120,.4); }
  .fes-act:hover { transform: translateY(-2px); filter: brightness(1.15); }
  .fes-act:active { transform: translateY(1px) scale(.97); }
  .fes-act:focus-visible { outline: 3px solid #ffd36e; outline-offset: 2px; }
  .fes-report { display: inline-block; margin-top: 12px; font-size: 12px; color: rgba(255,255,255,.55); text-decoration: none; pointer-events: auto; }
  .fes-report:hover { color: #fff; text-decoration: underline; }
  .fes-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 12px 22px; border-radius: 999px; background: rgba(0,0,0,.75); color: #fff; border: 1px solid rgba(255,255,255,.18);
    font-size: 15px; font-weight: 800; pointer-events: none; animation: fesPop .4s cubic-bezier(.2,1.4,.4,1); z-index: 9500; max-width: 92vw; text-align: center; }
  .fes-confetti { position: fixed; inset: 0; pointer-events: none; z-index: 9100; }
  /* カウントダウン */
  .fes-count { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 8900; }
  .fes-count .n { font-size: min(34vh, 40vw); font-weight: 900; line-height: 1; color: #fff; text-shadow: 0 0 40px rgba(255,211,110,.8), 0 6px 0 rgba(0,0,0,.35); animation: fesCount .8s cubic-bezier(.2,1.2,.4,1) both; }
  .fes-count .n.go { color: #ffd36e; animation: fesGo .7s ease-out both; }
  /* ポーズ */
  .fes-pause .fes-title { font-size: 40px; letter-spacing: .3em; }
  .fes-pause .fes-sub { margin-bottom: 18px; }
  .fes-pause .fes-actions { flex-direction: column; align-items: stretch; }
  .fes-pause .fes-act { width: 100%; }
  /* エラー */
  .fes-err { font-size: 12px; opacity: .55; word-break: break-all; margin: 6px 0 14px; max-height: 60px; overflow: hidden; }
  `;

  /* ------------------------------------------------------------ UI */
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => c && e.appendChild(c));
    return e;
  }
  FES.el = el;

  let ui = null;
  function ensureUI() {
    if (ui) return ui;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    ui = el('div', { id: 'fes-ui' });
    (document.body || document.documentElement).appendChild(ui);
    return ui;
  }

  FES.init = function (o) {
    cfg = Object.assign({ ranking: true, buttons: true }, o || {});
    const build = () => {
      ensureUI();
      if (cfg.buttons !== false) {
        ui.appendChild(el('a', { id: 'fes-home', class: 'fes-btn', href: '../index.html', title: 'ホームへ', text: '🏠', onclick: () => FES.sfx('select') }));
        ui.appendChild(el('div', { id: 'fes-mute', class: 'fes-btn', title: 'ミュート', text: muted ? '🔇' : '🔊', onclick: () => { FES.setMuted(!muted); if (!muted) FES.sfx('select'); } }));
        if (document.documentElement.requestFullscreen) ui.appendChild(el('div', { id: 'fes-full', class: 'fes-btn', title: '全画面', text: '⛶', onclick: FES.toggleFullscreen }));
      }
      // 最初の操作で音を解放
      const unlock = () => { ensureAudio(); };
      ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));
      // タブに戻ってきたとき、音が止まったままにならないように
      document.addEventListener('visibilitychange', () => { if (!document.hidden && actx && actx.state === 'suspended') actx.resume().catch(() => {}); });
      document.title = cfg.title ? `${cfg.title} | NEON FESTA` : document.title;
      if (FES.lite()) document.documentElement.classList.add('fes-lite');
      // ページを開くときの演出はしない（描画後に重なって不自然に見えるため）。出るときだけ暗転
      // 共通UI内のリンク（🏠・つぎは・ホームへ）は暗転してから移動
      ui.addEventListener('click', e => {
        const a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a || !ui.contains(a)) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1 || a.target === '_blank') return;
        e.preventDefault(); FES.leaveTo(a.getAttribute('href'));
      });
      // 部屋の PC: 起動時と 20 秒ごとに共有ランキングを取ってくる（ハイスコア表示・ランクイン判定用）
      if (FES.isRoomPC()) { FES.sync(); setInterval(FES.sync, 20000); armIdleReset(); }
      armErrorGuard();
    };
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
    return FES;
  };

  /* ------------------------------------------------------------ エラー時の自動復帰 */
  // 文化祭の最中にスクリプトエラーで画面が固まると、スタッフが気づくまで誰も遊べない。
  // エラーが起きたら案内を出し、部屋の PC なら数秒で自動的に読み込み直す。
  let errShown = false;
  function armErrorGuard() {
    const onErr = msg => {
      msg = String(msg || '');
      if (errShown || /ResizeObserver|Script error\.?$/.test(msg)) return;
      errShown = true;
      try {
        ensureUI();
        const isHub = cfg.id === 'hub';
        const home = isHub ? 'index.html' : '../index.html';
        let left = 8;
        const cnt = el('span', { text: String(left) });
        const card = el('div', { class: 'fes-card' }, [
          el('h2', { text: 'おっと' }),
          el('div', { class: 'fes-title', text: 'エラーが起きました' }),
          el('div', { class: 'fes-sub', text: 'ごめんなさい！ 読み込み直すと直ることがほとんどです。' }),
          el('div', { class: 'fes-err', text: msg.slice(0, 160) }),
          el('div', { class: 'fes-actions' }, [
            el('button', { class: 'fes-act', text: '🔄 読み込み直す', onclick: () => location.reload() }),
            el('a', { class: 'fes-act alt', href: home, text: '🏠 ホームへ' }),
          ]),
          FES.isRoomPC() ? el('div', { class: 'fes-sub', style: 'margin-top:12px' }, [document.createTextNode('あと '), cnt, document.createTextNode(' 秒で自動的に読み込み直します')]) : null,
        ]);
        ui.appendChild(el('div', { class: 'fes-overlay', style: 'z-index:9900' }, [card]));
        if (FES.isRoomPC()) {
          const tm = setInterval(() => { left--; cnt.textContent = String(left); if (left <= 0) { clearInterval(tm); location.reload(); } }, 1000);
        }
      } catch (e) { /* ここで失敗しても何もしない */ }
    };
    global.addEventListener('error', e => onErr(e && (e.message || (e.error && e.error.message))));
    global.addEventListener('unhandledrejection', e => { const r = e && e.reason; onErr(r && (r.message || r)); });
  }

  /* ------------------------------------------------------------ 次の人へ自動リセット（部屋の PC） */
  // スタッフが少ないので、しばらく誰も触らなければ自動で「次の人」の状態に戻す。
  // 戻す前にカウントダウンを出し、触ればそのまま続けられる。
  // 秒数は PC ごとに localStorage の fes:idleResetSec で変えられる（既定 150 秒）
  const IDLE_RESET_SEC = Math.max(30, +LS.get('fes:idleResetSec', 150) || 150), IDLE_WARN_SEC = 15;
  function armIdleReset() {
    let last = Date.now(), warnEl = null;
    const isHub = cfg.id === 'hub';
    const touch = () => { last = Date.now(); if (warnEl) { warnEl.remove(); warnEl = null; } };
    ['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove'].forEach(ev => document.addEventListener(ev, touch, { passive: true, capture: true }));
    // ホームで、まだ誰のカードでもない（スタンプも名前もない）ときは戻す必要がない
    const needsReset = () => {
      if (!isHub) return true;
      const c = FES.stampCard();
      return !!(c && (c.name || Object.keys(c.stamps).length));
    };
    setInterval(() => {
      if (document.hidden) { last = Date.now(); return; }
      const idle = (Date.now() - last) / 1000;
      if (idle < IDLE_RESET_SEC - IDLE_WARN_SEC || !needsReset()) return;
      const left = Math.max(0, Math.ceil(IDLE_RESET_SEC - idle));
      if (!warnEl) {
        ensureUI();
        warnEl = el('div', { class: 'fes-overlay', style: 'z-index:9800' }, [el('div', { class: 'fes-card' }, [
          el('h2', { text: 'まだ あそんでる？' }),
          el('div', { class: 'fes-title', text: 'つぎの人に交代します' }),
          el('div', { class: 'fes-score', text: String(left) }),
          el('div', { class: 'fes-sub', text: 'つづけるときは、画面をタッチするか キーを押してね' }),
        ])]);
        ui.appendChild(warnEl);
      }
      const sc = warnEl.querySelector('.fes-score');
      if (sc.textContent !== String(left)) { sc.textContent = String(left); if (left <= 5) FES.sfx('tick'); }
      if (left <= 0) {
        FES.newStampCard('');
        try { localStorage.removeItem('fes:lastName'); } catch (e) {}
        location.href = isHub ? 'index.html' : '../index.html';
      }
    }, 1000);
  }

  FES.toggleFullscreen = function () {
    const d = document;
    if (!d.fullscreenElement) { (d.documentElement.requestFullscreen || function () {}).call(d.documentElement); }
    else if (d.exitFullscreen) d.exitFullscreen();
  };

  let toastEl = null;
  FES.toast = function (msg, ms) {
    ensureUI();
    if (toastEl) toastEl.remove();
    toastEl = el('div', { class: 'fes-toast', text: msg });
    ui.appendChild(toastEl);
    const me = toastEl;
    setTimeout(() => { me.remove(); if (toastEl === me) toastEl = null; }, ms || 1500);
  };

  /* ------------------------------------------------------------ カウントダウン / ポーズ（任意で使う） */
  /** 3・2・1・GO! を大きく出す。 FES.countdown(() => startPlay()) 。戻り値は cancel() */
  FES.countdown = function (onGo, o) {
    ensureUI(); o = o || {};
    const labels = o.labels || ['3', '2', '1', 'GO!'];
    const step = o.interval == null ? 0.75 : o.interval;
    const box = el('div', { class: 'fes-count' });
    ui.appendChild(box);
    let i = 0, tm = null, cancelled = false;
    const show = () => {
      if (cancelled) return;
      box.innerHTML = '';
      const last = i === labels.length - 1;
      box.appendChild(el('div', { class: 'n' + (last ? ' go' : ''), text: labels[i] }));
      FES.sfx(last ? 'go' : 'countdown');
      if (last) { if (onGo) onGo(); tm = setTimeout(() => box.remove(), 700); }
      else { i++; tm = setTimeout(show, step * 1000); }
    };
    show();
    return () => { cancelled = true; clearTimeout(tm); box.remove(); };
  };
  let pauseEl = null;
  /** ポーズ画面。 FES.pause(true, { onResume, onRetry }) / FES.pause(false) */
  FES.pause = function (show, o) {
    ensureUI(); o = o || {};
    if (pauseEl) { pauseEl.remove(); pauseEl = null; }
    if (!show) return;
    const card = el('div', { class: 'fes-card fes-pause' }, [
      el('h2', { text: cfg.title || '' }),
      el('div', { class: 'fes-title', text: 'PAUSE' }),
      el('div', { class: 'fes-sub', text: o.hint || 'Esc か P でも再開できます' }),
      el('div', { class: 'fes-actions' }, [
        el('button', { class: 'fes-act', text: '▶ つづける', onclick: () => { FES.sfx('select'); FES.pause(false); o.onResume && o.onResume(); } }),
        o.onRetry ? el('button', { class: 'fes-act alt', text: '↺ はじめから', onclick: () => { FES.sfx('select'); FES.pause(false); o.onRetry(); } }) : null,
        el('a', { class: 'fes-act alt', href: '../index.html', text: '🏠 ホームへ' }),
      ]),
    ]);
    pauseEl = el('div', { class: 'fes-overlay', style: 'z-index:9400' }, [card]);
    ui.appendChild(pauseEl);
  };
  FES.isPaused = () => !!pauseEl;

  /* ------------------------------------------------------------ 紙吹雪（リザルトのランクイン時） */
  function confetti(ms, colors) {
    ensureUI();
    const cv = el('canvas', { class: 'fes-confetti' });
    ui.appendChild(cv);
    const ctx = cv.getContext('2d');
    const W = cv.width = innerWidth, H = cv.height = innerHeight;
    const cols = colors || ['#ffd36e', '#ff4d8d', '#5ee7ff', '#8a6bff', '#5cff8d', '#fff'];
    const ps = Array.from({ length: Math.min(FES.lite() ? 60 : 160, Math.round(W * H / (FES.lite() ? 18000 : 9000))) }, () => ({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - .5) * 120, vy: 120 + Math.random() * 220,
      w: 6 + Math.random() * 8, h: 10 + Math.random() * 10, rot: Math.random() * 6.3, vr: (Math.random() - .5) * 8, c: cols[(Math.random() * cols.length) | 0], ph: Math.random() * 6.3,
    }));
    const t0 = performance.now(); let last = t0;
    (function frame(now) {
      if (!cv.isConnected) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const life = (now - t0) / ms;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = life > 0.75 ? Math.max(0, 1 - (life - 0.75) / 0.25) : 1;
      for (const p of ps) {
        p.x += (p.vx + Math.sin(now / 300 + p.ph) * 60) * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.y > H + 30 && life < 0.6) { p.y = -20; p.x = Math.random() * W; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, Math.cos(now / 150 + p.ph)); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (life < 1) requestAnimationFrame(frame); else cv.remove();
    })(t0);
    return cv;
  }
  FES.confetti = confetti;

  let overlay = null;
  FES.hideResult = function () { if (overlay) { overlay.remove(); overlay = null; } document.querySelectorAll('.fes-confetti').forEach(c => c.remove()); };

  /**
   * リザルト画面を表示する。
   * FES.showResult({
   *   score: 12345,             // 数値（大きいほど良い）
   *   scoreLabel: 'pt',         // 単位（省略可）
   *   title: 'GAME OVER',       // 見出し（省略可: 'RESULT'）
   *   subtitle: 'ステージ3で撃墜',
   *   stats: [{label:'MAX COMBO', value: 120}, ...],
   *   ranking: true,            // false でランキング登録なし
   *   retryLabel: 'もう一度',
   *   stamp: true,              // false でスタンプを押さない
   *   rank: { S: 50000, A: 30000, B: 15000, C: 5000 },   // ランクのしきい値（点数で判定）。または grade: 'S' を直接
   *   titles: { S: 'タイピング神', A: '達人' }, // 称号の上書き（任意）
   * }, onRetry)
   */
  FES.showResult = function (o, onRetry) {
    ensureUI(); FES.hideResult(); FES.pause(false);
    o = o || {};
    const score = Math.max(0, Math.floor(o.score || 0));
    const useRank = (o.ranking != null ? o.ranking : cfg.ranking) && score > 0;
    const rankIn = useRank && FES.isRankIn(score);
    const prev = FES.getRanking();
    const isTop = rankIn && (!prev.length || score > prev[0].score);
    const games = FES.games();
    FES.fever(false);
    // ランク（S/A/B/C/D）: しきい値 or 直接指定。対戦などランキング無しのゲームは grade 指定のときだけ
    const grade = o.grade || ((o.ranking != null ? o.ranking : cfg.ranking) ? FES.grade(score, o.rank) : null);
    const gradeInfo = grade && cfg.id !== 'hub' ? FES.saveGrade(FES.stampBase(cfg.id), grade) : null;
    // スタンプラリー: 1回遊び終えたらスタンプ（同じゲームは1枚のカードに1つ）
    let st = null;
    if (cfg.id !== 'hub' && o.stamp !== false) st = FES.addStamp(cfg.id, grade);

    const card = el('div', { class: 'fes-card' + (rankIn ? ' rankin' : '') });
    card.appendChild(el('h2', { text: cfg.title || '' }));
    card.appendChild(el('div', { class: 'fes-title', text: o.title || 'RESULT' }));
    let scoreEl = null;
    if (o.score != null) {
      scoreEl = el('div', { class: 'fes-score', text: '0' });
      if (o.scoreLabel) scoreEl.appendChild(el('small', { text: o.scoreLabel }));
      card.appendChild(scoreEl);
    }
    if (o.subtitle) card.appendChild(el('div', { class: 'fes-sub', text: o.subtitle }));
    const recBox = el('div');
    card.appendChild(recBox);
    // ランクの判子（スコアのカウントアップが終わってから押す）
    let gradeBox = null;
    if (grade) {
      gradeBox = el('div', { class: 'fes-grade-wrap' });
      card.appendChild(gradeBox);
    }
    if (o.stats && o.stats.length) {
      const g = el('div', { class: 'fes-stats' });
      o.stats.forEach(s => g.appendChild(el('div', { class: 'fes-stat' }, [el('b', { text: String(s.value) }), el('span', { text: String(s.label) })])));
      card.appendChild(g);
    }
    // スタンプの進み具合（ホームがゲーム一覧を登録していれば出す）
    const cardNow = FES.stampCard();
    if (games.length && cardNow && cfg.id !== 'hub') {
      const have = cardNow.stamps || {};
      const n = Object.keys(have).filter(k => games.some(g => g.id === k)).length;
      const lbl = el('div', { class: 'fes-stamp-lbl' });
      lbl.innerHTML = cardNow.done ? '🏅 スタンプ <b>コンプリート！</b> 殿堂入り' : `🎟 スタンプ <b>${n} / ${games.length}</b>${n < games.length ? `　あと ${games.length - n} 個で殿堂入り` : ''}`;
      const row = el('div', { class: 'fes-stamps' });
      games.forEach(g => {
        const on = !!have[g.id];
        const isNew = st && st.added && FES.stampBase(cfg.id) === g.id;
        row.appendChild(el('div', { class: 'fes-stamp' + (on ? ' on' : '') + (isNew ? ' new' : ''), style: `--c:${g.accent || '#ff4d8d'}`, text: g.icon || '★', title: g.title || '' }));
      });
      card.appendChild(lbl); card.appendChild(row);
      // 会場の PC だけ: 手でわたす景品（シール＝遊んだ人みんな、表彰状＝殿堂入り）の案内
      if (FES.isRoomPC()) card.appendChild(el('div', { class: 'fes-stamp-lbl', html: cardNow.done ? '📜 <b>スタッフを呼んでね！</b> 殿堂入りの表彰状をもらえるよ' : '🌟 帰るときに <b>出口で NEON FESTA シール</b> をもらってね' }));
      if (st && st.added) setTimeout(() => { FES.sfx('stamp'); FES.vibrate(30); }, 650);
      if (st && st.complete) setTimeout(() => { FES.sfx('powerup'); FES.toast('🎉 スタンプ コンプリート！ ホームで殿堂入りを確認しよう', 4000); confetti(4000); }, 1300);
      // ミッション・バッジ（新しく達成したものだけ大きく出す）
      const freshM = FES.claimMissions(FES.stampCard()), freshB = FES.claimBadges(FES.stampCard());
      const ms = FES.missionProgress(FES.stampCard());
      if (ms.length) {
        const doneN = ms.filter(m => m.done).length;
        const mrow = el('div', { class: 'fes-missions' });
        mrow.appendChild(el('span', { class: 'lbl', text: `🎯 今日のミッション ${doneN}/${ms.length}` }));
        ms.forEach(m => mrow.appendChild(el('span', { class: 'm' + (m.done ? ' done' : ''), text: (m.done ? '✔ ' : '○ ') + m.text + (m.goal > 1 && !m.done ? `（${m.cur}/${m.goal}）` : '') })));
        card.appendChild(mrow);
      }
      if (freshM.length || freshB.length) {
        const box = el('div', { class: 'fes-badges' });
        freshM.forEach(m => box.appendChild(el('div', { class: 'fes-badge mission' }, [el('b', { text: '🎯 ミッション達成！' }), el('span', { text: m.text })])));
        freshB.forEach(b => box.appendChild(el('div', { class: 'fes-badge' }, [el('b', { text: `${b.icon} バッジ獲得「${b.name}」` }), el('span', { text: b.desc })])));
        card.appendChild(box);
        setTimeout(() => { FES.sfx('powerup'); FES.vibrate([20, 30, 40]); }, 1000);
      }
      const ep = FES.eligiblePrizes(FES.stampCard());
      if (ep.length) {
        card.appendChild(el('div', { class: 'fes-prize', text: `🎁 景品ゲット！ ${ep.map(p => p.icon + ' ' + p.title).join('　')} — ホーム画面で QRコード を読んでね` }));
      }
    }

    const rankBox = el('div');
    card.appendChild(rankBox);
    const renderRank = (mine) => {
      rankBox.innerHTML = '';
      if (!useRank) return;
      const r = FES.getRanking();
      if (!r.length) return;
      const ul = el('ul', { class: 'fes-rank' });
      r.forEach((e, i) => {
        const li = el('li', { class: mine && e.date === mine ? 'me' : '' });
        li.appendChild(el('span', { class: 'r g' + (i + 1), text: ['🥇', '🥈', '🥉'][i] || (i + 1) + '.' }));
        li.appendChild(el('span', { class: 'n', text: e.name }));
        li.appendChild(el('span', { class: 's', text: e.score.toLocaleString() }));
        ul.appendChild(li);
      });
      rankBox.appendChild(ul);
      const me = ul.querySelector('li.me'); if (me) me.scrollIntoView({ block: 'nearest' });
    };

    const actions = el('div', { class: 'fes-actions' });
    const retryBtn = el('button', { class: 'fes-act', text: o.retryLabel || 'もう一度', onclick: () => { FES.sfx('start'); FES.hideResult(); onRetry && onRetry(); } });
    actions.appendChild(retryBtn);
    // つぎのおすすめ: まだスタンプのないゲームからひとつ
    if (games.length && cardNow && !cardNow.done) {
      const rest = games.filter(g => !(cardNow.stamps || {})[g.id] && g.id !== FES.stampBase(cfg.id));
      if (rest.length) {
        const g = rest[(Math.random() * rest.length) | 0];
        actions.appendChild(el('a', { class: 'fes-act next', href: `./${g.id}.html`, text: `つぎは ${g.icon || ''} ${g.title}` }));
      }
    }
    actions.appendChild(el('a', { class: 'fes-act alt', href: '../index.html', text: '🏠 ホームへ' }));

    let submitName = null;
    if (rankIn) {
      // 名前はボタンで選ぶ（色＋どうぶつ）。キーボードが苦手な人・小さい子でも登録できる。
      const picker = FES.namePicker(FES.currentName());
      const ok = el('button', { class: 'fes-act', text: 'この名前で登録' });
      const nameBox = el('div', { class: 'fes-namebox' }, [picker.el, el('div', { class: 'fes-actions' }, [ok])]);
      card.appendChild(nameBox);
      submitName = () => {
        const name = picker.value();
        FES.setCurrentName(name);
        const top = FES.saveScore(name, score);
        const mine = top.filter(e => e.name === name && e.score === score).sort((x, y) => y.date - x.date)[0];   // 同じ名前・同じ点の古い記録があっても、今の記録を光らせる
        nameBox.remove(); submitName = null;
        renderRank(mine ? mine.date : null);
        FES.sfx('coin');
        FES.toast(`${name} で登録しました！`, 1800);
      };
      ok.addEventListener('click', submitName);
    } else {
      renderRank(null);
    }
    card.appendChild(actions);
    // 不具合・要望の窓口（インターネットにつながっているときだけ意味がある）
    if (global.navigator && global.navigator.onLine !== false) {
      card.appendChild(el('a', { class: 'fes-report', href: FEEDBACK_URL, target: '_blank', rel: 'noopener noreferrer', text: '🐛 バグ報告・要望を送る' }));
    }
    overlay = el('div', { id: 'fes-overlay' }, [card]);
    ui.appendChild(overlay);

    // スコアのカウントアップ → 結果の音（ランクインならファンファーレ＋紙吹雪）
    const finish = () => {
      if (scoreEl) { scoreEl.classList.add('done'); }
      if (grade && gradeBox) {
        const col = FES.gradeColor(grade);
        gradeBox.appendChild(el('div', { class: 'fes-grade g' + grade, style: `--gc:${col}` }, [
          el('div', { class: 'lbl', text: 'RANK' }),
          el('div', { class: 'g', text: grade }),
        ]));
        gradeBox.appendChild(el('div', { class: 'fes-grade-title', style: `color:${col}`, text: FES.gradeTitle(grade, o.titles) + (gradeInfo && gradeInfo.improved && gradeInfo.prev ? `　（${gradeInfo.prev} → ${grade} にアップ！）` : gradeInfo && gradeInfo.improved && !gradeInfo.prev ? '' : '') }));
        setTimeout(() => { FES.sfx('grade' + grade); if (grade === 'S') { FES.vibrate([40, 40, 80]); confetti(2600, ['#ffd36e', '#fff6cc', '#ffb347', '#fff']); } }, 80);
      }
      if (rankIn) {
        setTimeout(() => { FES.sfx(isTop ? 'fanfare' : 'rankin'); FES.vibrate([30, 40, 60]); }, grade ? 650 : 0);
        recBox.appendChild(el('div', { class: 'fes-newrec', text: isTop ? '★ NEW RECORD! 1位 ★' : '★ RANK IN! ★' }));
        confetti(isTop ? 4500 : 2800);
      } else if (grade) { /* ランクの音だけ */ }
      else if (o.score != null && score > 0) FES.sfx('coin');
      else FES.sfx('gameover');
    };
    if (scoreEl && score > 0) FES.countUp(v => { scoreEl.firstChild.nodeValue = Math.round(v).toLocaleString(); }, 0, score, Math.min(1.2, 0.4 + Math.log10(score + 1) * 0.18), finish);
    else { if (scoreEl) scoreEl.firstChild.nodeValue = score.toLocaleString(); finish(); }

    // キー操作: Enter/Space でリトライ（名前入力中は除く）
    // 名前がまだ登録されていなければ、Enter は「登録」（うっかりリトライで記録が消えないように）
    const key = e => {
      if (!overlay) { document.removeEventListener('keydown', key); return; }
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (submitName) submitName(); else retryBtn.click(); }
    };
    setTimeout(() => document.addEventListener('keydown', key), 600);
    return overlay;
  };

  /* ------------------------------------------------------------ スタンプラリー */
  // 1回遊ぶ（リザルトが出る）ごとに、そのゲームのスタンプが1つ押される。
  // カードは端末ごとに1枚（ブースのPCなら「次の人」で新しいカードにする）。
  // 全ゲーム集めると「殿堂」に名前と所要時間が残る。
  const STAMP_KEY = 'fes:stamp:card', HALL_KEY = 'fes:stamp:hall', TOTAL_KEY = 'fes:stamp:total';
  FES.stampBase = id => String(id || cfg.id).split('_')[0];      // rhythm_hard → rhythm
  FES.stampTotal = () => LS.get(TOTAL_KEY, 0);                     // ハブが起動時に書き込む
  FES.setStampTotal = n => LS.set(TOTAL_KEY, n | 0);
  FES.stampCard = () => LS.get(STAMP_KEY, null);                   // { name, started, stamps:{id:ts}, done:ts|null }
  FES.newStampCard = function (name) {
    const c = { name: String(name == null ? '' : name).trim().slice(0, 8), started: Date.now(), stamps: {}, done: null };
    LS.set(STAMP_KEY, c); return c;
  };
  FES.renameStampCard = function (name) {
    const c = FES.stampCard() || FES.newStampCard('');
    c.name = String(name == null ? '' : name).trim().slice(0, 8); LS.set(STAMP_KEY, c); return c;
  };
  FES.stampHall = () => FES.isRoomPC() ? cloud().hall : LS.get(HALL_KEY, []);   // [{ name, date, timeMs, count }]
  FES.clearStampHall = () => LS.set(HALL_KEY, []);
  /** スタンプを押す。戻り値 { card, added, count, total, complete } */
  FES.addStamp = function (id, grade) {
    const base = FES.stampBase(id);
    const c = FES.stampCard() || FES.newStampCard('');
    if (grade) { c.grades = c.grades || {}; if (!c.grades[base] || FES.gradeIndex(grade) < FES.gradeIndex(c.grades[base])) { c.grades[base] = grade; LS.set(STAMP_KEY, c); } }
    const total = FES.stampTotal();
    if (c.done || c.stamps[base]) return { card: c, added: false, count: Object.keys(c.stamps).length, total, complete: !!c.done };
    c.stamps[base] = Date.now();
    const count = Object.keys(c.stamps).length;
    let complete = false;
    if (total > 0 && count >= total) {
      c.done = Date.now(); complete = true;
      const rec = { name: c.name || 'ななし', date: c.done, timeMs: c.done - c.started, count };
      if (FES.isRoomPC()) {
        const cl = cloud(); cl.hall = cl.hall.concat(rec).sort((a, b) => a.timeMs - b.timeMs).slice(0, 20); LS.set(CLOUD_KEY, cl);
        postOrQueue('/api/hall', { name: rec.name, timeMs: rec.timeMs, count, pc: room.pc });
      } else {
        const hall = FES.stampHall();
        hall.push(rec);
        LS.set(HALL_KEY, hall.slice(-100));
      }
    }
    LS.set(STAMP_KEY, c);
    return { card: c, added: true, count, total, complete };
  };
  /* ------------------------------------------------------------ バッジ（カードごとの実績） */
  const BADGES = [
    { id: 'first', icon: '🎮', name: 'はじめの一歩', desc: 'ゲームを1つ遊んだ', check: (c, n) => n >= 1 },
    { id: 'half', icon: '⭐', name: '半分クリア', desc: '半分のゲームにスタンプ', check: (c, n, total) => total > 0 && n >= Math.ceil(total / 2) },
    { id: 'complete', icon: '🏅', name: '殿堂入り', desc: '全部のゲームを遊んだ', check: c => !!c.done },
    { id: 'rankS', icon: '💎', name: 'Sランク', desc: 'どれかのゲームで ランク S', check: c => Object.values(c.grades || {}).includes('S') },
    { id: 'rankA3', icon: '🔥', name: 'A以上 ×3', desc: '3つのゲームで ランク A 以上', check: c => Object.values(c.grades || {}).filter(g => g === 'S' || g === 'A').length >= 3 },
    { id: 'allB', icon: '🌈', name: 'オールB以上', desc: '全部のゲームで ランク B 以上', check: c => !!c.done && FES.games().length > 0 && FES.games().every(g => 'SAB'.includes((c.grades || {})[g.id] || 'x')) },
    { id: 'versus', icon: '⚔️', name: '対戦デビュー', desc: '対戦ゲーム（ホッケー / デュエル）を遊んだ', check: c => !!(c.stamps.duel || c.stamps.hockey) },
    { id: 'speed', icon: '⚡', name: 'スピードラン', desc: '20分以内に殿堂入り', check: c => !!c.done && (c.done - c.started) <= 20 * 60000 },
    { id: 'mission', icon: '🎯', name: 'ミッション制覇', desc: '今日のミッションを全部クリア', check: c => FES.missionsDone(c) },
  ];
  FES.badgeDefs = () => BADGES;
  FES.earnedBadges = function (c) {
    c = c || FES.stampCard(); if (!c) return [];
    const total = FES.stampTotal(), n = Object.keys(c.stamps || {}).length;
    return BADGES.filter(b => { try { return b.check(c, n, total); } catch (e) { return false; } });
  };
  /** 新しく獲得したバッジを返し、カードに記録する（2回目以降は返さない） */
  FES.claimBadges = function (c) {
    c = c || FES.stampCard(); if (!c) return [];
    c.badges = c.badges || {};
    const fresh = FES.earnedBadges(c).filter(b => !c.badges[b.id]);
    fresh.forEach(b => { c.badges[b.id] = Date.now(); });
    if (fresh.length) LS.set(STAMP_KEY, c);
    return fresh;
  };

  /* ------------------------------------------------------------ 今日のミッション（日付で決まる3つ。どのPCでも同じ） */
  const gradeAtLeast = (c, id, g) => { const have = (c.grades || {})[id]; return !!have && FES.gradeIndex(have) <= FES.gradeIndex(g); };
  function missionPool() {
    const games = FES.games();
    const play = [
      { id: 'play3', text: 'ゲームを 3 つ遊ぶ', goal: 3, prog: c => Object.keys(c.stamps || {}).length },
      { id: 'play5', text: 'ゲームを 5 つ遊ぶ', goal: 5, prog: c => Object.keys(c.stamps || {}).length },
      { id: 'versus', text: '対戦ゲーム（🏒 or ⚔️）を遊ぶ', goal: 1, prog: c => (c.stamps && (c.stamps.duel || c.stamps.hockey)) ? 1 : 0 },
    ];
    const rank = [
      { id: 'anyA', text: 'どれかのゲームで ランク A 以上', goal: 1, prog: c => Object.values(c.grades || {}).filter(g => g === 'S' || g === 'A').length },
      { id: 'twoB', text: '2 つのゲームで ランク B 以上', goal: 2, prog: c => Object.values(c.grades || {}).filter(g => 'SAB'.includes(g)).length },
      { id: 'anyS', text: 'どれかのゲームで ランク S', goal: 1, prog: c => Object.values(c.grades || {}).filter(g => g === 'S').length },
    ];
    const per = games.filter(g => g.id !== 'duel').map(g => ({ id: 'b_' + g.id, text: `${g.icon || ''} ${g.title} で ランク B 以上`, goal: 1, prog: c => gradeAtLeast(c, g.id, 'B') ? 1 : 0 }));
    return { play, rank, per };
  }
  FES.missionSeed = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  FES.missions = function () {
    const pool = missionPool(); let seed = FES.missionSeed();
    const pick = arr => { if (!arr.length) return null; seed = (seed * 1103515245 + 12345) & 0x7fffffff; return arr[seed % arr.length]; };
    return [pick(pool.play), pick(pool.rank), pick(pool.per)].filter(Boolean);
  };
  FES.missionProgress = function (c) {
    c = c || FES.stampCard() || { stamps: {}, grades: {} };
    return FES.missions().map(m => { let cur = 0; try { cur = Math.min(m.goal, m.prog(c) || 0); } catch (e) {} return Object.assign({}, m, { cur, done: cur >= m.goal }); });
  };
  FES.missionsDone = c => { const ms = FES.missionProgress(c); return ms.length > 0 && ms.every(m => m.done); };
  /** 新しく達成したミッションを返し、カードに記録する */
  FES.claimMissions = function (c) {
    c = c || FES.stampCard(); if (!c) return [];
    c.missions = c.missions || {};
    const fresh = FES.missionProgress(c).filter(m => m.done && !c.missions[m.id]);
    fresh.forEach(m => { c.missions[m.id] = Date.now(); });
    if (fresh.length) LS.set(STAMP_KEY, c);
    return fresh;
  };

  /* ------------------------------------------------------------ 景品（QRコードの行き先。既定は自作ゲーム2本。スタッフがホームで変えられる） */
  const PRIZES_KEY = 'fes:prizes';
  const PRIZE_PAGE = 'https://tiaraearth-create.github.io/neon-festa/prize.html';   // QR の行き先（ホーム画面に追加のしかた付き）
  const DEFAULT_PRIZES = [
    { id: 'blitz', title: 'Block Blitz Arena', desc: 'ブロックパズル × オンライン対戦。1v1 ランクマッチ・2v2・レイドボス', icon: '🧩', url: 'https://block-blitz-arena.onrender.com/', cond: 'mission' },
    { id: 'core', title: 'コア工場タイクーン', desc: '施設を建ててコインを稼ぎ、敵からコアを守るタイクーン × 防衛', icon: '🏭', url: 'https://core-factory-tycoon.onrender.com/', cond: 'complete' },
  ];
  const COND_LABEL = { complete: '全部のゲームを遊ぶ（殿堂入り）', mission: '今日のミッションを全部クリア', any: '1回でも遊んだ人みんな', off: '配らない' };
  FES.prizeCondLabel = c => COND_LABEL[c] || c;
  FES.defaultPrizes = () => DEFAULT_PRIZES.map(p => Object.assign({}, p));
  FES.prizes = () => { const v = LS.get(PRIZES_KEY, null); return Array.isArray(v) && v.length ? v : FES.defaultPrizes(); };
  FES.setPrizes = list => { if (!list) { LS.set(PRIZES_KEY, null); return FES.prizes(); } LS.set(PRIZES_KEY, list.map(p => ({ id: p.id, title: String(p.title || '').trim(), desc: String(p.desc || '').trim(), icon: p.icon || '🎁', url: String(p.url || '').trim(), cond: p.cond || 'complete' }))); return FES.prizes(); };
  // 既定のままなら ?p=ID だけ。スタッフが URL や名前を変えた景品は、URL・名前・アイコンも QR に入れる（prize.html は別の端末で開くので、このPCの設定を読めない。説明文は QR が細かくなるので入れない）
  FES.prizeQrUrl = p => {
    const d = DEFAULT_PRIZES.find(x => x.id === p.id);
    if (d && d.url === p.url && d.title === p.title) return `${PRIZE_PAGE}?p=${encodeURIComponent(p.id)}`;
    const q = new URLSearchParams({ p: p.id, u: p.url, t: p.title || '景品' });
    if (p.icon) q.set('i', p.icon);
    return `${PRIZE_PAGE}?${q}`;
  };
  const condMet = (cond, c) => { const n = Object.keys(c.stamps || {}).length; return cond === 'any' ? n >= 1 : cond === 'mission' ? FES.missionsDone(c) : cond === 'complete' ? !!c.done : false; };
  /** いまのカードでもらえる景品の一覧 */
  FES.eligiblePrizes = function (c) { c = c || FES.stampCard(); if (!c) return []; return FES.prizes().filter(p => p.url && condMet(p.cond, c)); };
  FES.prizeEligible = c => FES.eligiblePrizes(c).length > 0;
  // 互換（古い呼び出し）
  FES.prize = () => FES.prizes()[0] || null;
  FES.setPrize = o => { if (!o || !o.url) return FES.setPrizes(null); return FES.setPrizes([{ id: 'custom', title: o.label || '景品', desc: '', icon: '🎁', url: o.url, cond: o.cond || 'complete' }]); };

  FES.formatDuration = function (ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' : '') + (h ? String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };

  /* ------------------------------------------------------------ 便利関数 */
  FES.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  FES.lerp = (a, b, t) => a + (b - a) * t;
  FES.rand = (a, b) => a + Math.random() * (b - a);
  FES.randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  FES.pick = arr => arr[Math.floor(Math.random() * arr.length)];
  FES.pad = (n, w) => String(n).padStart(w || 2, '0');
  FES.isTouch = () => ('ontouchstart' in global) || (global.navigator && global.navigator.maxTouchPoints > 0);

  /**
   * キャンバスを画面に合わせる。 FES.fitCanvas(canvas, 960, 540) → 内部解像度固定・CSSで拡縮。
   * 戻り値: { scale, offsetX, offsetY, toGame(clientX, clientY) }
   */
  FES.fitCanvas = function (canvas, W, H, opts) {
    opts = opts || {};
    const st = { scale: 1, offsetX: 0, offsetY: 0 };
    const dpr = Math.min(global.devicePixelRatio || 1, opts.maxDpr || 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    canvas.style.position = 'absolute';
    function resize() {
      const vw = global.innerWidth, vh = global.innerHeight;
      const s = Math.min(vw / W, vh / H);
      st.scale = s; st.offsetX = (vw - W * s) / 2; st.offsetY = (vh - H * s) / 2;
      canvas.style.width = (W * s) + 'px'; canvas.style.height = (H * s) + 'px';
      canvas.style.left = st.offsetX + 'px'; canvas.style.top = st.offsetY + 'px';
    }
    st.toGame = (cx, cy) => ({ x: (cx - st.offsetX) / st.scale, y: (cy - st.offsetY) / st.scale });
    st.resize = resize;
    global.addEventListener('resize', resize);
    global.addEventListener('orientationchange', () => setTimeout(resize, 50));
    resize();
    return st;
  };

  global.FES = FES;
})(window);
