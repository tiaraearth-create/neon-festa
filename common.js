/* =====================================================================
   FES  —  文化祭ゲーム共通ライブラリ
   ---------------------------------------------------------------------
   全ゲームで共通に使う「効果音 / ランキング / リザルト画面 / ホームボタン」。
   外部依存なし。オフラインでも動作する。

   使い方（最小）:
     FES.init({ id: 'rhythm', title: 'リズムスターズ' });
     FES.sfx('hit');                         // 効果音
     FES.showResult({ score: 12345, stats:[{label:'MAX COMBO', value:120}] },
                    () => restartGame());    // リザルト + ランキング登録
   ===================================================================== */
(function (global) {
  'use strict';

  const FES = {};
  let cfg = { id: 'game', title: 'GAME', ranking: true };
  // 運営への不具合・要望の窓口（ゲームフィードバックセンター）
  const FEEDBACK_URL = 'https://game-feedback.brainrot-rumble.workers.dev/?game=bunkasai-game-center&lang=ja';
  FES.feedbackUrl = FEEDBACK_URL;

  /* ------------------------------------------------------------ 保存 */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
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
  /** 送れなかった記録を1件ずつ送り直す（サーバーの連打制限に引っかからないよう少しずつ） */
  async function flushQueue() {
    const q = LS.get(QUEUE_KEY, []);
    if (!q.length) return;
    const item = q[0];
    try { await api(item.path, { method: 'POST', body: item.body }); }
    catch (e) { if (!e.status || e.status === 429 || e.status >= 500) return; }   // 通信エラー等は次回また送る。400系は捨てる
    LS.set(QUEUE_KEY, LS.get(QUEUE_KEY, []).slice(1));
  }
  function postOrQueue(path, body) {
    api(path, { method: 'POST', body }).catch(e => {
      if (e.status && e.status !== 429 && e.status < 500) return;
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

  /* ------------------------------------------------------------ 名前（色＋どうぶつ） */
  // 名前は今のスタンプカードに結びつける。「次の人」で新しいカードになると名前もリセットされる。
  FES.NAME_COLORS = ['あか', 'あお', 'きいろ', 'みどり', 'ピンク', 'むらさき', 'オレンジ', 'しろ', 'くろ', 'きん'];
  FES.NAME_ANIMALS = ['ネコ', 'イヌ', 'ウサギ', 'クマ', 'パンダ', 'キツネ', 'ペンギン', 'ライオン', 'イルカ', 'ドラゴン'];
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
    const row = (list, get, set) => {
      const r = el('div', { class: 'fes-pick-row' });
      list.forEach(v => r.appendChild(el('button', { class: 'fes-chip', type: 'button', text: v, onclick: () => { set(v); FES.sfx('select'); sync(); } })));
      r.sync = () => r.querySelectorAll('.fes-chip').forEach(b => b.classList.toggle('on', b.textContent === get()));
      return r;
    };
    const cRow = row(FES.NAME_COLORS, () => color, v => color = v);
    const aRow = row(FES.NAME_ANIMALS, () => animal, v => animal = v);
    const omakase = el('button', { class: 'fes-chip omakase', type: 'button', text: '🎲 おまかせ', onclick: () => {
      const r = FES.randomName(); color = FES.NAME_COLORS.find(c => r.startsWith(c)); animal = r.slice(color.length); FES.sfx('select'); sync();
    } });
    function sync() { show.textContent = color + animal; cRow.sync(); aRow.sync(); }
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

  function ensureAudio() {
    if (!actx) {
      try {
        actx = new (global.AudioContext || global.webkitAudioContext)();
        master = actx.createGain();
        master.gain.value = muted ? 0 : 0.5;
        master.connect(actx.destination);
      } catch (e) { return null; }
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  FES.audioContext = () => ensureAudio();
  FES.unlockAudio = ensureAudio;
  FES.setMuted = function (m) {
    muted = !!m; LS.set('fes:muted', muted);
    if (master) master.gain.value = muted ? 0 : 0.5;
    const b = document.getElementById('fes-mute'); if (b) b.textContent = muted ? '🔇' : '🔊';
  };
  FES.isMuted = () => muted;

  /**
   * 汎用トーン。 FES.tone({freq:440, dur:0.1, type:'square', vol:0.3, slide:880, attack:0.005, decay:0.1})
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
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (o.dur || 0.1));
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + (o.dur || 0.1) + 0.05);
  };
  /** ノイズ（爆発・ヒット用） */
  FES.noise = function (o) {
    const ac = ensureAudio(); if (!ac || muted) return;
    o = o || {};
    const dur = o.dur || 0.2;
    const t0 = ac.currentTime + (o.delay || 0);
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.slide) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.slide), t0 + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(o.vol == null ? 0.3 : o.vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  };

  /** プリセット効果音 */
  const SFX = {
    select:   () => FES.tone({ freq: 880, dur: 0.06, type: 'square', vol: 0.15 }),
    start:    () => { [523, 659, 784, 1047].forEach((f, i) => FES.tone({ freq: f, dur: 0.12, delay: i * 0.08, type: 'square', vol: 0.2 })); },
    hit:      () => FES.tone({ freq: 660, slide: 990, dur: 0.07, type: 'triangle', vol: 0.3 }),
    perfect:  () => { FES.tone({ freq: 1320, dur: 0.08, type: 'sine', vol: 0.3 }); FES.tone({ freq: 1760, dur: 0.12, delay: 0.04, type: 'sine', vol: 0.2 }); },
    miss:     () => FES.tone({ freq: 220, slide: 110, dur: 0.18, type: 'sawtooth', vol: 0.2 }),
    coin:     () => { FES.tone({ freq: 988, dur: 0.06, type: 'square', vol: 0.2 }); FES.tone({ freq: 1319, dur: 0.18, delay: 0.06, type: 'square', vol: 0.2 }); },
    jump:     () => FES.tone({ freq: 300, slide: 700, dur: 0.15, type: 'square', vol: 0.2 }),
    explode:  () => { FES.noise({ dur: 0.4, freq: 900, slide: 80, vol: 0.4 }); FES.tone({ freq: 90, slide: 30, dur: 0.35, type: 'sine', vol: 0.4 }); },
    shoot:    () => FES.tone({ freq: 1200, slide: 300, dur: 0.08, type: 'sawtooth', vol: 0.12 }),
    powerup:  () => { [440, 554, 659, 880, 1108].forEach((f, i) => FES.tone({ freq: f, dur: 0.1, delay: i * 0.05, type: 'triangle', vol: 0.22 })); },
    combo:    () => { FES.tone({ freq: 1047, dur: 0.05, type: 'square', vol: 0.15 }); FES.tone({ freq: 1568, dur: 0.1, delay: 0.05, type: 'square', vol: 0.15 }); },
    bounce:   () => FES.tone({ freq: 500, slide: 350, dur: 0.06, type: 'triangle', vol: 0.25 }),
    gameover: () => { [523, 494, 440, 392, 349].forEach((f, i) => FES.tone({ freq: f, dur: 0.25, delay: i * 0.18, type: 'triangle', vol: 0.25 })); },
    fanfare:  () => { [523, 523, 523, 659, 784, 1047].forEach((f, i) => FES.tone({ freq: f, dur: i === 5 ? 0.6 : 0.14, delay: [0, .15, .3, .45, .6, .8][i], type: 'square', vol: 0.22 })); },
    tick:     () => FES.tone({ freq: 1500, dur: 0.03, type: 'square', vol: 0.08 }),
    countdown:() => FES.tone({ freq: 660, dur: 0.15, type: 'square', vol: 0.25 }),
    go:       () => FES.tone({ freq: 1320, dur: 0.4, type: 'square', vol: 0.3 }),
    wrong:    () => { FES.tone({ freq: 200, dur: 0.15, type: 'square', vol: 0.25 }); FES.tone({ freq: 160, dur: 0.25, delay: 0.15, type: 'square', vol: 0.25 }); },
    correct:  () => { FES.tone({ freq: 1047, dur: 0.1, type: 'sine', vol: 0.3 }); FES.tone({ freq: 1568, dur: 0.25, delay: 0.1, type: 'sine', vol: 0.3 }); },
  };
  FES.sfx = function (name) { const f = SFX[name]; if (f) f(); };
  FES.sfxNames = Object.keys(SFX);

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
  #fes-overlay { pointer-events: auto; position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(5,5,20,.72); backdrop-filter: blur(8px); animation: fesFade .35s ease-out; }
  @keyframes fesFade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes fesPop { 0% { transform: scale(.7) translateY(30px); opacity: 0 } 60% { transform: scale(1.04) translateY(-4px); opacity: 1 } 100% { transform: scale(1) translateY(0) } }
  @keyframes fesScore { from { transform: scale(2.2); opacity: 0 } to { transform: scale(1); opacity: 1 } }
  @keyframes fesShine { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
  .fes-card { width: min(92vw, 520px); max-height: 94vh; overflow: auto; border-radius: 24px; padding: 28px 28px 22px; color: #fff; text-align: center;
    background: linear-gradient(160deg, rgba(30,30,70,.95), rgba(10,10,30,.97)); border: 1px solid rgba(255,255,255,.18);
    box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05) inset, 0 0 60px rgba(120,90,255,.25); animation: fesPop .5s cubic-bezier(.2,1.4,.4,1); }
  .fes-card h2 { margin: 0 0 4px; font-size: 14px; letter-spacing: .35em; opacity: .7; font-weight: 600; }
  .fes-card .fes-title { font-size: 26px; font-weight: 900; margin: 0 0 14px; letter-spacing: .05em;
    background: linear-gradient(90deg,#fff,#ffd36e,#fff,#8ed6ff,#fff); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: fesShine 3s linear infinite; }
  .fes-score { font-size: 56px; font-weight: 900; line-height: 1.1; margin: 8px 0 8px; font-variant-numeric: tabular-nums; animation: fesScore .6s cubic-bezier(.2,1.4,.4,1) .15s both; text-shadow: 0 0 30px rgba(255,220,120,.6); }
  .fes-score small { font-size: 16px; opacity: .7; margin-left: 4px; }
  .fes-sub { opacity: .8; font-size: 14px; margin-bottom: 14px; }
  .fes-newrec { display: inline-block; margin: 6px 0 10px; padding: 4px 14px; border-radius: 999px; font-weight: 900; font-size: 13px; letter-spacing: .15em;
    background: linear-gradient(90deg,#ff4d8d,#ffb347); box-shadow: 0 0 20px rgba(255,120,80,.6); animation: fesPop .6s .3s both; }
  .fes-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px,1fr)); gap: 8px; margin: 12px 0 16px; }
  .fes-stat { background: rgba(255,255,255,.07); border-radius: 12px; padding: 8px 6px; }
  .fes-stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .fes-stat span { font-size: 11px; opacity: .65; letter-spacing: .1em; }
  .fes-name { display: flex; gap: 8px; justify-content: center; margin: 8px 0 14px; }
  .fes-name input { pointer-events: auto; width: 180px; font-size: 22px; text-align: center; padding: 8px 10px; border-radius: 12px; border: 2px solid rgba(255,255,255,.35);
    background: rgba(0,0,0,.4); color: #fff; outline: none; font-weight: 700; letter-spacing: .1em; }
  .fes-name input:focus { border-color: #ffd36e; box-shadow: 0 0 16px rgba(255,211,110,.5); }
  .fes-name button { padding: 8px 18px; }
  .fes-namebox { margin: 4px 0 14px; }
  .fes-pick { margin-bottom: 12px; }
  .fes-pick-lbl { font-size: 11px; letter-spacing: .2em; opacity: .6; margin: 8px 0 4px; }
  .fes-pick-name { font-size: 30px; font-weight: 900; margin: 2px 0 4px; color: #ffd36e; text-shadow: 0 0 18px rgba(255,211,110,.5); }
  .fes-pick-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .fes-chip { pointer-events: auto; padding: 7px 11px; min-height: 38px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08);
    color: #fff; font-size: 15px; font-weight: 700; cursor: pointer; transition: transform .1s, background .1s; }
  .fes-chip:hover { background: rgba(255,255,255,.18); }
  .fes-chip:active { transform: scale(.94); }
  .fes-chip.on { background: linear-gradient(135deg,#6a5cff,#b04dff); border-color: transparent; box-shadow: 0 4px 14px rgba(120,80,255,.5); }
  .fes-chip.omakase { margin-top: 8px; }
  .fes-rank { text-align: left; margin: 0 0 14px; padding: 0; list-style: none; max-height: 220px; overflow: auto; font-variant-numeric: tabular-nums; }
  .fes-rank li { display: flex; align-items: center; gap: 10px; padding: 5px 10px; border-radius: 8px; font-size: 14px; }
  .fes-rank li:nth-child(odd) { background: rgba(255,255,255,.05); }
  .fes-rank li.me { background: linear-gradient(90deg, rgba(255,211,110,.35), rgba(255,77,141,.25)); font-weight: 900; box-shadow: 0 0 0 1px rgba(255,211,110,.5) inset; }
  .fes-rank .r { width: 28px; font-weight: 900; opacity: .8; }
  .fes-rank .r.g1 { color: #ffd36e; } .fes-rank .r.g2 { color: #d9d9e6; } .fes-rank .r.g3 { color: #e8a26a; }
  .fes-rank .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fes-rank .s { font-weight: 700; }
  .fes-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .fes-act { pointer-events: auto; padding: 12px 26px; border-radius: 14px; border: 0; font-size: 16px; font-weight: 900; cursor: pointer; color: #fff; letter-spacing: .05em;
    background: linear-gradient(135deg,#6a5cff,#b04dff); box-shadow: 0 8px 24px rgba(120,80,255,.45); transition: transform .12s, filter .12s; text-decoration: none; display: inline-block; }
  .fes-act.alt { background: rgba(255,255,255,.12); box-shadow: none; }
  .fes-act:hover { transform: translateY(-2px); filter: brightness(1.15); }
  .fes-act:active { transform: translateY(1px) scale(.97); }
  .fes-report { display: inline-block; margin-top: 12px; font-size: 12px; color: rgba(255,255,255,.55); text-decoration: none; pointer-events: auto; }
  .fes-report:hover { color: #fff; text-decoration: underline; }
  .fes-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 10px 18px; border-radius: 999px; background: rgba(0,0,0,.7); color: #fff;
    font-size: 14px; font-weight: 700; pointer-events: none; animation: fesFade .3s; z-index: 9500; }
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

  let ui = null;
  function ensureUI() {
    if (ui) return ui;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    ui = el('div', { id: 'fes-ui' });
    document.body.appendChild(ui);
    return ui;
  }

  FES.init = function (o) {
    cfg = Object.assign({ ranking: true, buttons: true }, o || {});
    const build = () => {
      ensureUI();
      if (cfg.buttons !== false) {
        ui.appendChild(el('a', { id: 'fes-home', class: 'fes-btn', href: '../index.html', title: 'ホームへ', text: '🏠', onclick: () => FES.sfx('select') }));
        ui.appendChild(el('div', { id: 'fes-mute', class: 'fes-btn', title: 'ミュート', text: muted ? '🔇' : '🔊', onclick: () => { FES.setMuted(!muted); if (!muted) FES.sfx('select'); } }));
        ui.appendChild(el('div', { id: 'fes-full', class: 'fes-btn', title: '全画面', text: '⛶', onclick: FES.toggleFullscreen }));
      }
      // 最初の操作で音を解放
      const unlock = () => { ensureAudio(); };
      ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { passive: true }));
      // ページ内の a[href] クリック音
      document.title = cfg.title ? `${cfg.title} | NEON FESTA` : document.title;
      // 部屋の PC: 起動時と 20 秒ごとに共有ランキングを取ってくる（ハイスコア表示・ランクイン判定用）
      if (FES.isRoomPC()) { FES.sync(); setInterval(FES.sync, 20000); }
    };
    if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
    return FES;
  };

  FES.toggleFullscreen = function () {
    const d = document;
    if (!d.fullscreenElement) { (d.documentElement.requestFullscreen || function () {}).call(d.documentElement); }
    else if (d.exitFullscreen) d.exitFullscreen();
  };

  FES.toast = function (msg, ms) {
    ensureUI();
    const t = el('div', { class: 'fes-toast', text: msg });
    ui.appendChild(t);
    setTimeout(() => t.remove(), ms || 1500);
  };

  let overlay = null;
  FES.hideResult = function () { if (overlay) { overlay.remove(); overlay = null; } };

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
   * }, onRetry)
   */
  FES.showResult = function (o, onRetry) {
    ensureUI(); FES.hideResult();
    o = o || {};
    const score = Math.max(0, Math.floor(o.score || 0));
    const useRank = (o.ranking != null ? o.ranking : cfg.ranking) && score > 0;
    const rankIn = useRank && FES.isRankIn(score);
    if (rankIn) FES.sfx('fanfare'); else FES.sfx('gameover');
    // スタンプラリー: 1回遊び終えたらスタンプ（同じゲームは1枚のカードに1つ）
    if (cfg.id !== 'hub' && o.stamp !== false) {
      const st = FES.addStamp(cfg.id);
      if (st.added) setTimeout(() => {
        if (st.complete) { FES.sfx('powerup'); FES.toast('🎉 スタンプ コンプリート！ ホームで殿堂入りを確認しよう', 4000); }
        else FES.toast(`🎟 スタンプ GET！ ${st.count}${st.total ? ' / ' + st.total : ''}`, 2500);
      }, 900);
    }

    const card = el('div', { class: 'fes-card' });
    card.appendChild(el('h2', { text: cfg.title || '' }));
    card.appendChild(el('div', { class: 'fes-title', text: o.title || 'RESULT' }));
    if (o.score != null) {
      const s = el('div', { class: 'fes-score', text: score.toLocaleString() });
      if (o.scoreLabel) s.appendChild(el('small', { text: o.scoreLabel }));
      card.appendChild(s);
    }
    if (o.subtitle) card.appendChild(el('div', { class: 'fes-sub', text: o.subtitle }));
    if (rankIn) {
      const r = FES.getRanking();
      const isTop = !r.length || score > r[0].score;
      card.appendChild(el('div', { class: 'fes-newrec', text: isTop ? '★ NEW RECORD! 1位 ★' : '★ RANK IN! ★' }));
    }
    if (o.stats && o.stats.length) {
      const g = el('div', { class: 'fes-stats' });
      o.stats.forEach(st => g.appendChild(el('div', { class: 'fes-stat', html: `<b>${String(st.value)}</b><span>${st.label}</span>` })));
      card.appendChild(g);
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
        li.appendChild(el('span', { class: 'r g' + (i + 1), text: (i + 1) + '.' }));
        li.appendChild(el('span', { class: 'n', text: e.name }));
        li.appendChild(el('span', { class: 's', text: e.score.toLocaleString() }));
        ul.appendChild(li);
      });
      rankBox.appendChild(ul);
    };

    const actions = el('div', { class: 'fes-actions' });
    const retryBtn = el('button', { class: 'fes-act', text: o.retryLabel || 'もう一度' , onclick: () => { FES.sfx('start'); FES.hideResult(); onRetry && onRetry(); } });
    const homeBtn = el('a', { class: 'fes-act alt', href: '../index.html', text: 'ホームへ' });
    actions.appendChild(retryBtn); actions.appendChild(homeBtn);

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
        const mine = top.find(e => e.name === name && e.score === score);
        nameBox.remove(); submitName = null;
        renderRank(mine ? mine.date : null);
        FES.sfx('coin');
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
    // キー操作: Enter/Space でリトライ（名前入力中は除く）
    // 名前がまだ登録されていなければ、Enter は「登録」（うっかりリトライで記録が消えないように）
    const key = e => {
      if (!overlay) { document.removeEventListener('keydown', key); return; }
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (submitName) submitName(); else retryBtn.click(); }
    };
    setTimeout(() => document.addEventListener('keydown', key), 400);
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
  FES.addStamp = function (id) {
    const base = FES.stampBase(id);
    const c = FES.stampCard() || FES.newStampCard('');
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
    resize();
    return st;
  };

  global.FES = FES;
})(window);
