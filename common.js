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

  /* ------------------------------------------------------------ 空き PC（部屋の PC がいまの様子をサーバーに知らせる） */
  // ホームで、まだ誰のカードでもない（名前もスタンプもない）＝「空き」。それ以外（ゲーム中・名前を選んだあと）＝「使用中」。
  // 変わったときと、変わらなくても 60 秒ごとに送る。3 分届かない PC は、空き PC のページで「止まっている」扱いになる。
  FES.pcState = function () {
    if (cfg.id !== 'hub') return 'busy';
    const c = FES.stampCard();
    return c && (c.name || Object.keys(c.stamps || {}).length) ? 'busy' : 'free';
  };
  let sentState = '', sentAt = 0;
  function sendPresence(force) {
    if (TEST || !FES.isRoomPC() || document.hidden) return;
    const st = FES.pcState();
    if (!force && st === sentState && Date.now() - sentAt < 60000) return;
    sentState = st; sentAt = Date.now();
    api('/api/room/state', { method: 'POST', body: { pc: room.pc, state: st } }).catch(() => { sentAt = Date.now() - 30000; });   // 失敗したら 30 秒後にもう一度
  }
  FES.sendPresence = sendPresence;

  /* ------------------------------------------------------------ ラストスパート（14:00〜15:00。board.html の EVENT と同じ） */
  // 軽音部の時間も人を呼ぶためのイベント。本番の日だけホーム画面に帯を出す。ためすときは ?evnow=2026-11-03T14:10
  const EVENT = { date: '2026-11-03', start: '14:00', end: '15:00' };
  FES.EVENT = EVENT;
  const evOffset = (() => { const q = global.location && new URLSearchParams(global.location.search).get('evnow'); const t = q && Date.parse(q); return t ? t - Date.now() : 0; })();
  const evAt = hm => new Date(`${EVENT.date}T${hm}:00`);
  /** 'before' | 'on' | 'after' | null（本番の日以外） */
  FES.eventPhase = function () {
    const t = Date.now() + evOffset, a = +evAt(EVENT.start), b = +evAt(EVENT.end);
    if (t < a - 6 * 3600e3 || t > b + 6 * 3600e3) return null;
    return t < a ? 'before' : t < b ? 'on' : 'after';
  };
  function armEventBanner() {
    const bar = el('div', { class: 'fes-evbar' });
    const tick = () => {
      const ph = FES.eventPhase();
      bar.style.display = ph === 'on' ? '' : 'none';
      if (ph !== 'on') return;
      const left = Math.max(0, Math.round((+evAt(EVENT.end) - Date.now() - evOffset) / 1000));
      bar.innerHTML = `<span class="tag">BOSS STAGE</span>⏰ ラストスパート！ ${EVENT.end} に本日のチャンピオン決定 あと <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b>`;
    };
    tick(); setInterval(tick, 1000);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  function armPresence() {
    sendPresence(true);
    setInterval(() => sendPresence(false), 5000);
    document.addEventListener('visibilitychange', () => sendPresence(true));
  }

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
    setBtnIcon(document.getElementById('fes-mute'), muted ? '🔇' : '🔊');
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

  /* ------------------------------------------------------------ あそびかた（スタートの前に、まん中に大きく出す） */
  let howtoEl = null, howtoTm = null, howtoKey = null, howtoPass = false, howtoShownAt = -1e9;
  const HOWTO_AUTO = 8, HOWTO_AGAIN_MS = 120000;   // 8 秒で自動スタート／同じ人が 2 分以内にもう一度遊ぶときは出さない
  /**
   * ゲームのスタート処理のいちばん最初で:
   *   function startGame() { if (FES.howto(['🔨 クリックかタップでもぐらをたたく', '⭐ 金もぐらは +500'], 0, startGame, arguments)) return; … }
   *   → まん中に「あそびかた」を出して true を返す（スタート処理はいったん止める）。
   *     「OK！ あそぶ」・Enter・Space・8 秒で消えて、もう一度 startGame(…同じ引数) を呼ぶ（そのときは false が返って先へ進む）。
   *   FES.howto(false) で消す。
   *   先頭の絵文字（スペースまで）は左の四角いアイコンになる。[Space] のように [ ] でかこむとキーの形で出る。
   *   書き方のルール: 数字と単位はくっつける（3つ・60秒）／日本語と英字のあいだは空けない／
   *   いくつかの操作は「・」か「か」でつなぐ（[Space]かタップ）／点数の前（+500）と「／」の前後だけ空ける
   */
  /* ネオンの線のアイコン（絵文字のかわり。24×24 の線画。色はゲームの色・光は CSS）
     d: 線（パス）／ f: 1 のものは中をうすく塗る。キーは今までの絵文字（ゲームのファイルはそのまま書ける） */
  const ICONS = {
    '↔': [{ d: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4' }],
    '⬆': [{ d: 'M12 20V5M5 11l7-7 7 7' }],
    '⬇': [{ d: 'M12 4v15M5 13l7 7 7-7' }],
    '👈': [{ d: 'M20 12H6M11 6l-6 6 6 6' }, { d: 'M3 5v14' }],
    '👉': [{ d: 'M4 12h14M13 6l6 6-6 6' }, { d: 'M21 5v14' }],
    '🧱': [{ d: 'M3 5h18v14H3zM3 12h18M9 5v7M15 12v7', f: 1 }],
    '💥': [{ d: 'M12 2l2.2 5.4L20 6l-3 5L22 14l-5.6.9L17 21l-5-3.3L7 21l.6-6.1L2 14l5-3-3-5 5.8 1.4z', f: 1 }],
    '🟣': [{ d: 'M12 3c4 5 6.5 8 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 11 8 8 12 3z', f: 1 }, { d: 'M9 14.5a3 3 0 0 0 3 3' }],
    '✨': [{ d: 'M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z', f: 1 }, { d: 'M19 14l.9 2.1 2.1.9-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z' }],
    '🔗': [{ d: 'M10 14.5a4 4 0 0 1 0-5.7l2.8-2.8a4 4 0 0 1 5.7 5.7l-1.6 1.6M14 9.5a4 4 0 0 1 0 5.7l-2.8 2.8a4 4 0 0 1-5.7-5.7l1.6-1.6' }],
    '🏆': [{ d: 'M7 3h10v5a5 5 0 0 1-10 0z', f: 1 }, { d: 'M7 5H4a3 3 0 0 0 3.5 4.5M17 5h3a3 3 0 0 1-3.5 4.5M12 13v4M8 21h8M9.5 17h5v4h-5z' }],
    '🔫': [{ d: 'M2 8h15l3 1.5v3L17 14h-6l-1.5 6h-4L7 14H2z', f: 1 }, { d: 'M20 11h2M11 14l1 3' }],
    '🎯': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9z' }, { d: 'M12 11a1 1 0 1 0 0 2 1 1 0 1 0 0-2z', f: 1 }],
    '🏒': [{ d: 'M6 3l8 13h6v3h-8.5L3 4.5z', f: 1 }, { d: 'M4 19.5a3 1.3 0 1 0 6 0 3 1.3 0 1 0-6 0z' }],
    '🥅': [{ d: 'M3 19V7h18v12M3 7l3 4h12l3-4M6 11v8M18 11v8M10 11v8M14 11v8M6 15h12' }],
    '🔥': [{ d: 'M12 3c1 4 5.5 5.5 5.5 10.5a5.5 5.5 0 0 1-11 0c0-3 2-4.5 2.5-6.5 1 1 1.5 2 2 3.5 1-2 1.2-4.5 1-7.5z', f: 1 }],
    '👀': [{ d: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z' }, { d: 'M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z', f: 1 }],
    '👆': [{ d: 'M9 12V4.5a1.75 1.75 0 0 1 3.5 0V11M12.5 9.5a1.75 1.75 0 0 1 3.5 0V12M16 11a1.75 1.75 0 0 1 3.5 0v4c0 3.8-2.7 6-6 6h-1c-2.6 0-4.4-1.4-5.6-3.6l-2-3.8a1.6 1.6 0 0 1 2.7-1.7L9 14' }],
    '💡': [{ d: 'M12 2.5a6.5 6.5 0 0 0-4 11.6c.8.7 1 1.5 1 2.4h6c0-.9.2-1.7 1-2.4a6.5 6.5 0 0 0-4-11.6z', f: 1 }, { d: 'M9 19h6M10 22h4' }],
    '🔨': [{ d: 'M13 3l7 7-3 3-7-7z', f: 1 }, { d: 'M11.5 8.5L3.6 16.4a2 2 0 0 0 2.8 2.8l7.9-7.9' }],
    '⭐': [{ d: 'M12 2.8l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.4l-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z', f: 1 }],
    '💣': [{ d: 'M10.5 7.5a7 7 0 1 0 0 14 7 7 0 1 0 0-14z', f: 1 }, { d: 'M15 9l3-3M19 2v2M22 5h-2M20.5 3.5l1-1M7 13a3.5 3.5 0 0 1 3-3' }],
    '💎': [{ d: 'M6 3h12l4 6-10 12L2 9z', f: 1 }, { d: 'M2 9h20M9 3l-1.5 6L12 21M15 3l1.5 6L12 21' }],
    '🔢': [{ d: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z', f: 1 }],
    '⏱': [{ d: 'M12 5a8 8 0 1 0 0 16 8 8 0 1 0 0-16z', f: 1 }, { d: 'M12 9v4l3 2M10 2h4M12 2v3M19 6l1.5-1.5' }],
    '🛟': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8z' }, { d: 'M5.6 5.6l3.6 3.6M18.4 5.6l-3.6 3.6M5.6 18.4l3.6-3.6M18.4 18.4l-3.6-3.6' }],
    '🚀': [{ d: 'M12 2c4 3.2 5 8 4 12.5H8C7 10 8 5.2 12 2z', f: 1 }, { d: 'M8.2 12.5L5 17h3.5M15.8 12.5L19 17h-3.5M10 18l2 4 2-4M12 7.5a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6z' }],
    '🏁': [{ d: 'M5 21V3' }, { d: 'M5 4h14l-2.5 4.5L19 13H5z', f: 1 }, { d: 'M9.5 4v9M14 4v9M5 8.5h13' }],
    '🎹': [{ d: 'M3 5h18v14H3zM8 12v7M12 12v7M16 12v7', f: 1 }, { d: 'M6.5 5h3v7h-3zM10.5 5h3v7h-3zM14.5 5h3v7h-3z' }],
    '🎵': [{ d: 'M9 18V5l11-2v13' }, { d: 'M6 15a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM17 13a3 3 0 1 0 0 6 3 3 0 1 0 0-6z', f: 1 }],
    '🪙': [{ d: 'M12 2.5a6.5 9.5 0 1 0 0 19 6.5 9.5 0 1 0 0-19z', f: 1 }, { d: 'M9 8h6M9 12h6M9 16h6' }],
    '⌨': [{ d: 'M2 6h20v12H2z', f: 1 }, { d: 'M5.5 9.5h1M9 9.5h1M12.5 9.5h1M16 9.5h1M5.5 12.5h1M9 12.5h1M12.5 12.5h1M16 12.5h1M7 15.5h10' }],
    '✅': [{ d: 'M4 4h16v16H4z', f: 1 }, { d: 'M7.5 12.5l3 3 6-7' }],
    '⚡': [{ d: 'M13.5 2L4 14h7l-1.5 8L19 10h-7z', f: 1 }],
    '✸': [{ d: 'M12 21V7M12 21L5 9M12 21l7-12' }, { d: 'M12 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM4 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM20 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z', f: 1 }],
    '🛡': [{ d: 'M12 3l8 3v6c0 5-3.5 8.2-8 9.5-4.5-1.3-8-4.5-8-9.5V6z', f: 1 }, { d: 'M8.5 12l2.5 2.5 4.5-5' }],
    '🛸': [{ d: 'M7 11a5 4 0 0 1 10 0', f: 1 }, { d: 'M2 13c0-1.7 4.5-3 10-3s10 1.3 10 3-4.5 3-10 3-10-1.3-10-3z', f: 1 }, { d: 'M8 18.5l-1 2.5M12 18.5V21M16 18.5l1 2.5' }],
    '👑': [{ d: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z', f: 1 }, { d: 'M5 16h14' }],
    '🏠': [{ d: 'M3 11.5L12 4l9 7.5' }, { d: 'M5.5 10v10h5v-6h3v6h5V10', f: 1 }],
    '🔊': [{ d: 'M4 9h4l5-4v14l-5-4H4z', f: 1 }, { d: 'M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12' }],
    '🔇': [{ d: 'M4 9h4l5-4v14l-5-4H4z', f: 1 }, { d: 'M16 9l5 6M21 9l-5 6' }],
    '⛶': [{ d: 'M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6' }],
    '⚙': [{ d: 'M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13z', f: 1 }, { d: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22M4.9 4.9l2.5 2.5M16.6 16.6l2.5 2.5M4.9 19.1l2.5-2.5M16.6 7.4l2.5-2.5' }],
    '🐢': [{ d: 'M4 15a7.5 6.5 0 0 1 15 0z', f: 1 }, { d: 'M3 15h17M7 15v3.5M16 15v3.5M8 12l3.5-3 3.5 3M19 12.5h1.5a1.5 1.5 0 0 1 0 3H19' }],
    '📱': [{ d: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z', f: 1 }, { d: 'M11 18.5h2' }],
    '☠': [{ d: 'M12 3a7 7 0 0 0-7 7c0 2.5 1.3 4.2 3 5.2V19h8v-3.8c1.7-1 3-2.7 3-5.2a7 7 0 0 0-7-7z', f: 1 }, { d: 'M9 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM15 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM10.5 19v2M13.5 19v2' }],
    '🎧': [{ d: 'M4 15v-3a8 8 0 0 1 16 0v3' }, { d: 'M3.5 14h3.5v6.5H3.5zM17 14h3.5v6.5H17z', f: 1 }],
    '❄': [{ d: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M3.8 10.6l4.1 1.4-.9 4.2M20.2 10.6l-4.1 1.4.9 4.2' }],
    '🎨': [{ d: 'M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.5-2-.4-1.4.5-2.5 2-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z', f: 1 }, { d: 'M7.5 10.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM10 6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4zM14.5 6.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 1 0 0-2.4z' }],
    '🥁': [{ d: 'M4 9.5v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-6', f: 1 }, { d: 'M4 9.5c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5S16.4 6 12 6 4 7.6 4 9.5zM7 3l4 6M17 3l-4 6M8 13v5M16 13v5' }],
    '⚔': [{ d: 'M4 4l10 10M20 4L10 14' }, { d: 'M13 15l2-2 3 3-2 2zM11 15l-2-2-3 3 2 2z', f: 1 }, { d: 'M17 17l3 3M7 17l-3 3' }],
    '🪢': [{ d: 'M2 12c2.5-3 4.5 3 7 0s4.5 3 7 0 4.5 3 6 0' }, { d: 'M10.5 9h3v6h-3z', f: 1 }],
    '➕': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', f: 1 }, { d: 'M12 7.5v9M7.5 12h9' }],
    '✴': [{ d: 'M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z', f: 1 }, { d: 'M12 10a2 2 0 1 0 0 4 2 2 0 1 0 0-4z' }],
    '🧪': [{ d: 'M9 3h6M10 3v6l-5.2 9.2A1.9 1.9 0 0 0 6.5 21h11a1.9 1.9 0 0 0 1.7-2.8L14 9V3' }, { d: 'M7.3 15h9.4l1.6 3a.9.9 0 0 1-.8 1.3H6.5a.9.9 0 0 1-.8-1.3z', f: 1 }],
    '🗾': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', f: 1 }, { d: 'M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18' }],
    '✒': [{ d: 'M4 20l1.8-5.6L16 4.2l3.8 3.8L9.6 18.2z', f: 1 }, { d: 'M14 6.2l3.8 3.8M4 20l3-1' }],
    '🔤': [{ d: 'M3 18l4-12 4 12M4.4 14h5.2' }, { d: 'M14 6h3.6a2.6 2.6 0 0 1 0 5.2H14zM14 11.2h4.2a2.6 2.6 0 0 1 0 5.2H14z', f: 1 }],
    '➗': [{ d: 'M5 12h14' }, { d: 'M12 5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2zM12 15.8a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z', f: 1 }],
    '⚽': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z' }, { d: 'M12 8l3.3 2.4-1.3 3.9h-4l-1.3-3.9z', f: 1 }, { d: 'M12 8V3.5M15.3 10.4l4.2-1.6M14 14.3l2.6 3.8M10 14.3l-2.6 3.8M8.7 10.4L4.5 8.8' }],
    '🦒': [{ d: 'M4 5h16v11h-9l-5 4v-4H4z', f: 1 }, { d: 'M12 8v4M12 14v.4' }],
    '🏫': [{ d: 'M5 21V10l7-5 7 5v11z', f: 1 }, { d: 'M3 21h18M10 21v-5h4v5M12 5V2h3.5v2H12M10.5 11h3' }],
    '🖥': [{ d: 'M3 4h18v12H3z', f: 1 }, { d: 'M9 20h6M12 16v4' }],
    '🐱': [{ d: 'M4 10V3.5l4.5 3.5h7L20 3.5V10a8 8 0 0 1-16 0z', f: 1 }, { d: 'M9 11v1M15 11v1M12 14.5l-1 .8M12 14.5l1 .8M1.5 13h4M18.5 13h4' }],
    '🐶': [{ d: 'M7 6a6 6 0 0 1 10 0c1.5 1.5 2 4 2 6a7 7 0 0 1-14 0c0-2 .5-4.5 2-6z', f: 1 }, { d: 'M7 6L3 9l2 5M17 6l4 3-2 5M9.5 12v.5M14.5 12v.5M11 15.5h2' }],
    '🐰': [{ d: 'M9 9.5V3a1.5 1.5 0 0 1 3 0v6.5M12 9.5V3a1.5 1.5 0 0 1 3 0v6.5' }, { d: 'M12 9a6 6 0 1 0 0 12 6 6 0 1 0 0-12z', f: 1 }, { d: 'M10 14v.5M14 14v.5M11.3 17h1.4' }],
    '🐻': [{ d: 'M6.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM17.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM12 5a8 8 0 1 0 0 16 8 8 0 1 0 0-16z', f: 1 }, { d: 'M10 15.5a2 1.6 0 1 0 4 0 2 1.6 0 1 0-4 0M9.5 11v.5M14.5 11v.5' }],
    '🐼': [{ d: 'M6.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM17.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM12 5a8 8 0 1 0 0 16 8 8 0 1 0 0-16z' }, { d: 'M7.5 10.5l2.5-1.5.8 3-2.6.8zM16.5 10.5l-2.5-1.5-.8 3 2.6.8zM11 15.5h2l-1 1.2z', f: 1 }],
    '🦊': [{ d: 'M3 3.5l5 4.5h8l5-4.5-1 8.5-8 9-8-9z', f: 1 }, { d: 'M9.5 12.5v.5M14.5 12.5v.5M11.5 17.5h1' }],
    '🐧': [{ d: 'M12 3c4 0 6 4 6 9s-2 9-6 9-6-4-6-9 2-9 6-9z', f: 1 }, { d: 'M12 9.5c2 0 3 2.5 3 5.5s-1.3 4.5-3 4.5-3-1-3-4.5 1-5.5 3-5.5zM10.5 7v.4M13.5 7v.4M11 8.5h2l-1 1.2zM9 21h2M13 21h2' }],
    '🦁': [{ d: 'M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8' }, { d: 'M12 6a6 6 0 1 0 0 12 6 6 0 1 0 0-12z', f: 1 }, { d: 'M10 11v.5M14 11v.5M11 14.5h2' }],
    '🐬': [{ d: 'M2.5 15c3-6 9-9 15-8l3-3-.5 4c1.5 1.5 1.5 4-1 5-3 1.2-7 1-10 3l-1.5 3-.5-3.5c-1.5.5-3 .5-4.5-.5z', f: 1 }, { d: 'M16 10v.3' }],
    '🐲': [{ d: 'M3 14l4-6 3 1 2-5 2 4 4-1-1 5 4 3-5 2-2 4-4-1-3 2-1-4-3-1z', f: 1 }, { d: 'M14 11v.6M16.5 15h-3' }],
    '🏗': [{ d: 'M3 21h18M6 21V5h2v16M8 5h12M8 5l4 3M18 5v6' }, { d: 'M16 11h4v4h-4z', f: 1 }],
    '🏎': [{ d: 'M2 16l2-4h5l2-3h5l3 3h3v4z', f: 1 }, { d: 'M6 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM18 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4z' }],
    '❓': [{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18z', f: 1 }, { d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 16.5v.5' }],
    '🧠': [{ d: 'M12 5a3 3 0 0 0-5.5 1A3 3 0 0 0 4 10a3 3 0 0 0 1 5 3 3 0 0 0 3 4 3 3 0 0 0 4 0 3 3 0 0 0 4 0 3 3 0 0 0 3-4 3 3 0 0 0 1-5 3 3 0 0 0-2.5-4A3 3 0 0 0 12 5z', f: 1 }, { d: 'M12 5v14M8 10h2M14 10h2M8 14h2M14 14h2' }],
    '🧩': [{ d: 'M4 8h4.2a2 2 0 1 1 3.6 0H16v4.2a2 2 0 1 1 0 3.6V20H4z', f: 1 }],
    '🏭': [{ d: 'M3 21V11l5 3v-3l5 3V7h3l1-4h2l1 4v14z', f: 1 }, { d: 'M7 18h2M12 18h2' }],
    '🎟': [{ d: 'M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z', f: 1 }, { d: 'M9 7.5v2M9 11v2M9 14.5v2' }],
    '🏅': [{ d: 'M8 2l2.5 6.5M16 2l-2.5 6.5' }, { d: 'M12 8.5a6 6 0 1 0 0 12 6 6 0 1 0 0-12z', f: 1 }, { d: 'M12 11.3l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z' }],
    '🎁': [{ d: 'M3 9h18v4H3zM5 13h14v8H5z', f: 1 }, { d: 'M12 9v12M12 9c-2-4-6-4-6-1.5S10 9 12 9c2 0 6 1 6-1.5S14 5 12 9' }],
    '📜': [{ d: 'M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2z', f: 1 }, { d: 'M9 8h7M9 11h7M9 14h5' }],
    '🔄': [{ d: 'M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4' }],
    '🐛': [{ d: 'M12 7a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0v-3a5 5 0 0 0-5-5z', f: 1 }, { d: 'M9 7.5l-2-3M15 7.5l2-3M7 12H3M17 12h4M7 16l-3 2M17 16l3 2M12 9.5v10' }],
    '🎉': [{ d: 'M3 21l4-12 8 8z', f: 1 }, { d: 'M13 3v2M18 5.5l-1.5 1.5M21 11h-2M14.5 9.5c1-2 3-2.5 4.5-1.5M9 3.5c.5 1.5 0 3-1 4' }],
    '🎮': [{ d: 'M6 8h12a4 4 0 0 1 4 4v2a3 3 0 0 1-5.4 1.8L15 14H9l-1.6 1.8A3 3 0 0 1 2 14v-2a4 4 0 0 1 4-4z', f: 1 }, { d: 'M7 10.5v3M5.5 12h3M16 11v.4M18 12.6v.4' }],
    '🌈': [{ d: 'M2 18a10 10 0 0 1 20 0M5 18a7 7 0 0 1 14 0M8 18a4 4 0 0 1 8 0' }],
    '👤': [{ d: 'M12 4a4 4 0 1 0 0 8 4 4 0 1 0 0-8z', f: 1 }, { d: 'M4 21a8 8 0 0 1 16 0' }],
    '📺': [{ d: 'M3 7h18v12H3z', f: 1 }, { d: 'M8 3l4 4 4-4M7 22h10' }],
    '🗑': [{ d: 'M6 7l1 14h10l1-14z', f: 1 }, { d: 'M4 7h16M9 7V4h6v3M10 11v6M14 11v6' }],
    '🎪': [{ d: 'M12 3l9 8v10H3V11z', f: 1 }, { d: 'M12 3v18M12 3l-4.5 18M12 3l4.5 18M12 3V1h2' }],
    '🎲': [{ d: 'M4 4h16v16H4z', f: 1 }, { d: 'M8 7.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1zM16 7.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1zM12 11.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1zM8 15.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1zM16 15.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z' }],
  };
  ICONS['🐉'] = ICONS['🐲']; ICONS['🎖'] = ICONS['🏅']; ICONS['🌟'] = ICONS['⭐']; ICONS['🛟'] = ICONS['🛟'];
  /** 文字の中に入れる用: FES.iconSVG('🎲') → '<svg …>'（文字の色で描く。HTML 文字列を組み立てるところで使う） */
  FES.iconSVG = function (key) {
    const parts = ICONS[key]; if (!parts) return '';
    return `<svg class="fes-ico inl" viewBox="0 0 24 24" aria-hidden="true">${parts.map(pt => `<path d="${pt.d}"${pt.f ? ' class="f"' : ''}/>`).join('')}</svg>`;
  };
  /** HTML に <span data-ico="⚙"></span> と書いておくと、そこにアイコンが入る */
  /** 画面の文字（DOM）の中の絵文字を、自作のアイコン（<svg>）に自動で置きかえる。あとから出る文字も見張る */
  const ICON_RE = new RegExp('(' + Object.keys(ICONS).filter(k => ICONS[k]).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\uFE0F?', 'g');
  const SKIP_TAG = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, SELECT: 1, TITLE: 1, CANVAS: 1, svg: 1, SVG: 1 };
  function iconizeText(t) {
    const p = t.parentNode; if (!p || SKIP_TAG[p.nodeName] || p.closest && p.closest('svg')) return;
    const s = t.nodeValue; ICON_RE.lastIndex = 0; if (!s || !ICON_RE.test(s)) return;
    ICON_RE.lastIndex = 0;
    const frag = document.createDocumentFragment(); let last = 0, m;
    while ((m = ICON_RE.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const sp = document.createElement('span'); sp.className = 'fes-ei'; sp.innerHTML = FES.iconSVG(m[1]); frag.appendChild(sp);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    p.replaceChild(frag, t);
  }
  function iconizeTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { iconizeText(root); return; }
    if (root.nodeType !== 1 || SKIP_TAG[root.nodeName]) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = [];
    while (w.nextNode()) list.push(w.currentNode);
    list.forEach(iconizeText);
  }
  FES.autoIcons = function (root) {
    root = root || document.body; if (!root || root.__fesIcons) return; root.__fesIcons = true;
    iconizeTree(root);
    new MutationObserver(recs => { for (const r of recs) { if (r.type === 'characterData') iconizeText(r.target); else r.addedNodes.forEach(iconizeTree); } })
      .observe(root, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) FES.autoIcons(); else document.addEventListener('DOMContentLoaded', () => FES.autoIcons());
  FES.fillIcons = function (root) { (root || document).querySelectorAll('[data-ico]').forEach(e => { if (!e.firstChild) e.innerHTML = FES.iconSVG(e.getAttribute('data-ico')); }); };
  const ICON_IMG = {};
  /** キャンバス用: FES.iconImage('⚡', '#ffe66d') → <img>（SVG を 1 回だけ作って使い回す。読みこみ前は complete=false） */
  FES.iconImage = function (key, color) {
    const id = key + color; if (ICON_IMG[id]) return ICON_IMG[id];
    const parts = ICONS[key]; if (!parts) return null;
    const paths = parts.map(pt => `<path d="${pt.d}"${pt.f ? ` fill="${color}" fill-opacity=".22"` : ''}/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 26 26" width="104" height="104"><g fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return (ICON_IMG[id] = img);
  };
  /** キャンバスにアイコンを描く（まん中が x, y・大きさ size）。光らせるときは glow に色 */
  FES.drawIcon = function (ctx, key, x, y, size, color, glow) {
    const img = FES.iconImage(key, color); if (!img || !img.complete) return false;
    ctx.save(); if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = size * 0.35; }
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size); ctx.restore(); return true;
  };
  function setBtnIcon(b, key) { if (!b) return; b.textContent = ''; const sv = iconSvg(key); if (sv) b.appendChild(sv); else b.textContent = key; }
  /** FES.icon('⭐') → 光る線のアイコン（<svg>）。ないときは null */
  function iconSvg(key) {
    const parts = ICONS[key]; if (!parts) return null;
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'fes-ico'); svg.setAttribute('aria-hidden', 'true');
    for (const pt of parts) { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', pt.d); if (pt.f) path.setAttribute('class', 'f'); svg.appendChild(path); }
    return svg;
  }
  FES.icon = iconSvg;
  function howtoText(str) {   // [Space] → キーの形。DOM で組み立てる（innerHTML は使わない）
    const span = el('span', { class: 'tx' });
    str.split(/(\[[^\]]+\])/).forEach(part => { if (!part) return; const m = part.match(/^\[([^\]]+)\]$/); span.appendChild(m ? el('kbd', { text: m[1] }) : document.createTextNode(part)); });
    return span;
  }
  function howtoClose(go) {
    clearTimeout(howtoTm); howtoTm = null;
    if (howtoKey) { global.removeEventListener('keydown', howtoKey, true); howtoKey = null; }
    const me = howtoEl; howtoEl = null;
    if (me) { me.classList.add('out'); setTimeout(() => me.remove(), 300); }
    if (go) { FES.sfx('start'); howtoPass = true; try { go(); } finally { howtoPass = false; } }
  }
  FES.howto = function (hints, ms, fn, args) {
    ensureUI();
    if (hints === false || !hints || !hints.length) { howtoClose(null); return false; }
    if (howtoPass) return false;               // OK のあとの呼び直し → そのまま始める
    if (howtoEl) return true;                  // もう出ている（スタートの連打）
    if (fn && performance.now() - howtoShownAt < HOWTO_AGAIN_MS) return false;   // 同じ人の「もう一度」
    howtoShownAt = performance.now();
    const go = fn ? () => fn.apply(null, args ? Array.prototype.slice.call(args) : []) : null;
    const rows = hints.map((h, i) => {
      const sp = h.indexOf(' '), head = sp > 0 ? h.slice(0, sp) : '';
      const isIcon = head && head.length <= 4 && !/[0-9A-Za-z぀-ヿ一-鿿\[]/.test(head);
      return el('div', { class: 'row', style: `animation-delay:${0.15 + i * 0.1}s` }, [
        el('span', { class: 'ic' + (isIcon ? '' : ' num') }, [isIcon ? (iconSvg(head) || document.createTextNode(head)) : document.createTextNode(String(i + 1))]), howtoText(isIcon ? h.slice(sp + 1) : h)]);
    });
    const auto = fn ? HOWTO_AUTO : (ms || 4500) / 1000;
    const okBtn = fn ? el('button', { class: 'fes-act ok', type: 'button', text: 'OK！ あそぶ', onclick: e => { e.stopPropagation(); howtoClose(go); } }) : null;
    howtoEl = el('div', { class: 'fes-howto' + (fn ? ' gate' : ''), style: `--hc:${accentColor()}`, onpointerdown: e => e.stopPropagation() }, [
      el('div', { class: 'box' }, [
        el('div', { class: 'hd' }, [el('span', { class: 'en', text: 'HOW TO PLAY' }), el('span', { class: 'tt', text: cfg.title || 'あそびかた' })]),
        el('div', { class: 'rows' }, rows),
        okBtn,
        el('div', { class: 'bar' }, [el('i', { style: `animation-duration:${auto}s` })]),
        fn ? el('div', { class: 'note', text: `${HOWTO_AUTO}秒たつと自動で始まります（Enter・Spaceでもスタート）` }) : null,
      ]),
    ]);
    ui.appendChild(howtoEl);
    if (fn) {
      howtoKey = e => {   // 出ているあいだはゲームにキーを渡さない。Enter・Space でスタート
        e.stopImmediatePropagation();
        if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && !e.repeat) { e.preventDefault(); howtoClose(go); }
      };
      global.addEventListener('keydown', howtoKey, true);
      setTimeout(() => { try { okBtn.focus({ preventScroll: true }); } catch (err) { /* 古いブラウザ */ } }, 50);
    }
    howtoTm = setTimeout(() => howtoClose(go), auto * 1000);
    return !!fn;
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
  .fes-btn .fes-ico { width: 22px; height: 22px; stroke: #fff; filter: drop-shadow(0 0 3px rgba(94,231,255,.85)); }
  .fes-btn .fes-ico .f { fill: rgba(94,231,255,.25); }
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
  /* ラストスパートの帯（ホーム画面の上） */
  .fes-evbar { position: relative; z-index: 5; display: flex; align-items: center; gap: 10px; width: fit-content; max-width: calc(100% - 24px); margin: 8px auto 0; padding: 7px 16px 7px 8px; border-radius: 999px; font-weight: 900; font-size: 15px; color: #fff;
    background: linear-gradient(90deg, rgba(255,77,141,.92), rgba(255,159,67,.92)); box-shadow: 0 0 0 2px rgba(255,255,255,.5) inset, 0 6px 30px rgba(255,90,120,.55); font-family: "Noto Sans JP","Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif; font-variant-numeric: tabular-nums; pointer-events: none; }
  .fes-evbar .tag { font-family: Consolas,"Courier New",monospace; font-size: 11px; letter-spacing: .16em; color: #2a0f30; background: #ffd36e; border-radius: 999px; padding: 3px 9px; animation: fesBlink 1s steps(2) infinite; }
  .fes-evbar b { font-family: Consolas,"Courier New",monospace; font-size: 18px; letter-spacing: .04em; }
  @keyframes fesBlink { 50% { opacity: .35 } }
  /* 景品のはしご（ステージの地図） */
  .fes-track { position: relative; margin: 14px 26px 6px; height: 66px; }
  .fes-track .rail { position: absolute; left: 0; right: 0; top: 18px; height: 8px; border-radius: 99px; background: rgba(255,255,255,.12); box-shadow: inset 0 0 0 1px rgba(255,255,255,.15); }
  .fes-track .fill { position: absolute; left: 0; top: 18px; height: 8px; border-radius: 99px; background: linear-gradient(90deg, #5ee7ff, #ffd36e, #ff4d8d); box-shadow: 0 0 12px rgba(255,211,110,.7); }
  .fes-track .node { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; width: 90px; }
  .fes-track .node i { font-style: normal; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; font-size: 20px; background: #12122e; border: 2px dashed rgba(255,255,255,.35); filter: grayscale(.8); opacity: .7; }
  .fes-track .node.done i { filter: none; opacity: 1; border: 2px solid #ffd36e; background: radial-gradient(circle, rgba(255,211,110,.45), #2a1a3a); box-shadow: 0 0 16px rgba(255,211,110,.75); }
  .fes-track .node.next i { opacity: 1; filter: none; border: 2px solid #5ee7ff; animation: fesBump 1.1s ease-in-out infinite; box-shadow: 0 0 14px rgba(94,231,255,.7); }
  .fes-track .node span { margin-top: 3px; font-size: 10.5px; font-weight: 800; line-height: 1.2; color: rgba(255,255,255,.78); text-align: center; white-space: nowrap; }
  .fes-track .node span b { display: block; font-family: Consolas,"Courier New",monospace; font-size: 11px; color: #ffd36e; }
  .fes-next { font-size: 14px; font-weight: 900; color: #fff; margin: 8px 0 6px; }
  .fes-next b { color: #5ee7ff; font-size: 20px; font-family: Consolas,"Courier New",monospace; text-shadow: 0 0 10px rgba(94,231,255,.8); }
  /* 景品ゲット（アイテムゲットの演出） */
  .fes-get { overflow: hidden; }
  .fes-get-rays { position: absolute; left: 50%; top: 50%; width: 1100px; height: 1100px; margin: -550px 0 0 -550px; pointer-events: none; opacity: .32; border-radius: 50%;
    background: repeating-conic-gradient(from 0deg, rgba(255,211,110,.5) 0deg 8deg, transparent 8deg 22deg); animation: fesSpin 16s linear infinite; will-change: transform; }
  .fes-lite .fes-get-rays { animation: none; opacity: .2; }
  @keyframes fesSpin { to { transform: rotate(360deg) } }
  .fes-get .fes-getcard { position: relative; width: min(94vw, 660px); overflow-x: hidden; border: 2px solid #ffd36e; box-shadow: 0 0 0 4px rgba(10,8,30,.9), 0 0 0 6px rgba(255,211,110,.55), 0 0 70px rgba(255,211,110,.45);
    background: radial-gradient(ellipse at 50% 0%, rgba(255,211,110,.22), transparent 60%), linear-gradient(160deg, rgba(34,24,80,.97), rgba(10,8,30,.98)); }
  .fes-get-k { font-family: Consolas,"Courier New",monospace; font-size: 15px; font-weight: 900; letter-spacing: .4em; color: #ffd36e; animation: fesBlink .9s steps(2) 6; }
  .fes-get-big { font-size: clamp(32px, 6.4vw, 52px); font-weight: 900; color: #fff; letter-spacing: .03em; text-shadow: 0 0 10px #ffb347, 0 0 28px rgba(255,180,70,.8); animation: fesPop .6s cubic-bezier(.2,1.4,.4,1) both; margin: 2px 0 16px; }
  .fes-get-list { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; }
  .fes-get-item { position: relative; flex: 1 1 210px; max-width: 290px; padding: 18px 12px 14px; border-radius: 18px; background: rgba(255,255,255,.06); border: 2px solid var(--gc, #ffd36e);
    box-shadow: 0 0 22px color-mix(in srgb, var(--gc, #ffd36e) 45%, transparent), inset 0 0 18px color-mix(in srgb, var(--gc, #ffd36e) 15%, transparent); animation: fesGetIn .7s cubic-bezier(.2,1.5,.4,1) .2s both; }
  .fes-get-item::before { content: 'NEW'; position: absolute; top: -11px; left: 50%; transform: translateX(-50%); font-family: Consolas,"Courier New",monospace; font-size: 11px; font-weight: 900; letter-spacing: .18em; color: #1a0f30; background: var(--gc, #ffd36e); padding: 2px 10px; border-radius: 99px; }
  @keyframes fesGetIn { 0% { transform: translateY(40px) scale(.6); opacity: 0 } 70% { transform: translateY(-6px) scale(1.05); opacity: 1 } 100% { transform: none } }
  .fes-get-ic { font-size: 50px; line-height: 1.1; animation: fesFloat 2.4s ease-in-out .9s infinite; }
  @keyframes fesFloat { 50% { transform: translateY(-6px) } }
  .fes-get-t { font-size: 19px; font-weight: 900; color: #fff; margin: 4px 0 2px; text-shadow: 0 0 10px color-mix(in srgb, var(--gc, #ffd36e) 80%, transparent); }
  .fes-get-d { font-size: 12px; color: rgba(255,255,255,.75); line-height: 1.4; margin-bottom: 6px; }
  .fes-get-how { font-size: 14px; font-weight: 800; color: #fff; margin-top: 8px; }
  .fes-get-qr { display: inline-block; padding: 10px; background: #fff; border-radius: 12px; color: #333; min-width: 60px; box-shadow: 0 0 0 3px var(--gc, #ffd36e), 0 0 24px color-mix(in srgb, var(--gc, #ffd36e) 60%, transparent); }
  .fes-get-qr svg { display: block; width: 172px; height: 172px; }
  .fes-get-open { display: inline-block; margin-top: 8px; }
  .fes-get-next { margin: 18px auto 2px; max-width: 440px; font-size: 14px; font-weight: 800; }
  .fes-get-next b { color: #5ee7ff; font-size: 20px; font-family: Consolas,"Courier New",monospace; }
  .fes-get-bar { height: 12px; margin-top: 6px; border-radius: 99px; background: rgba(255,255,255,.12); overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,.2); }
  .fes-get-bar i { display: block; height: 100%; border-radius: 99px; background: repeating-linear-gradient(90deg, #5ee7ff 0 14px, #9ff3ff 14px 18px); box-shadow: 0 0 12px rgba(94,231,255,.8); transition: width 1s cubic-bezier(.2,1,.3,1) .5s; }
  .fes-get-note { font-size: 12px; color: rgba(255,255,255,.6); margin-top: 8px; }
  .fes-prize { margin: 10px 0 2px; padding: 10px 14px; border-radius: 14px; font-weight: 900; color: #2a2200; background: linear-gradient(90deg, #ffd36e, #ffb347); animation: fesBump 1.2s ease-in-out infinite; }
  .fes-howto { --hc: #5ee7ff; position: fixed; inset: 0; z-index: 8980; display: grid; place-items: center; padding: 16px; pointer-events: none; }
  .fes-howto.gate { pointer-events: auto; background: radial-gradient(ellipse at center, rgba(6,4,24,.72), rgba(2,2,12,.88)); animation: fesFade .25s ease both; }
  .fes-howto.out { animation: fesHowOut .3s ease both; }
  @keyframes fesHowOut { from { opacity: 1 } to { opacity: 0 } }
  .fes-howto .box { width: min(94vw, 620px); padding: 20px 22px 16px; border-radius: 20px;
    background: linear-gradient(180deg, rgba(20,14,52,.98), rgba(8,8,26,.98)); border: 2px solid var(--hc);
    box-shadow: 0 0 30px color-mix(in srgb, var(--hc) 45%, transparent), inset 0 0 24px color-mix(in srgb, var(--hc) 14%, transparent), 0 20px 60px rgba(0,0,0,.7);
    animation: fesHowIn .45s cubic-bezier(.2,1.3,.4,1) both; }
  @keyframes fesHowIn { from { opacity: 0; transform: translateY(26px) scale(.92) } to { opacity: 1; transform: none } }
  .fes-howto .hd { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid color-mix(in srgb, var(--hc) 40%, transparent); }
  .fes-howto .en { font-family: Consolas,"Courier New",monospace; font-size: 13px; font-weight: 900; letter-spacing: .3em; color: var(--hc); text-shadow: 0 0 10px var(--hc); }
  .fes-howto .tt { font-size: clamp(22px, 4.6vw, 30px); font-weight: 900; color: #fff; text-shadow: 0 0 14px color-mix(in srgb, var(--hc) 70%, transparent); }
  .fes-howto .rows { display: grid; gap: 10px; }
  .fes-howto .row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 12px; background: rgba(255,255,255,.05); animation: fesHowRow .4s cubic-bezier(.2,1.2,.4,1) both; }
  @keyframes fesHowRow { from { opacity: 0; transform: translateX(-20px) } to { opacity: 1; transform: none } }
  .fes-howto .ic { flex: none; width: 42px; height: 42px; display: grid; place-items: center; border-radius: 11px; font-size: 23px; line-height: 1;
    background: color-mix(in srgb, var(--hc) 18%, rgba(0,0,0,.4)); border: 1px solid color-mix(in srgb, var(--hc) 60%, transparent); }
  .fes-ico { width: 26px; height: 26px; fill: none; stroke: var(--hc, #5ee7ff); stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 3px var(--hc, #5ee7ff)); overflow: visible; }
  .fes-ico .f { fill: color-mix(in srgb, var(--hc, #5ee7ff) 22%, transparent); }
  .fes-lite .fes-ico { filter: none; }
  .fes-ico.inl { width: 1.15em; height: 1.15em; stroke: currentColor; filter: none; vertical-align: -.2em; margin-right: .15em; }
  .fes-ico.inl .f { fill: currentColor; fill-opacity: .22; }
  .fes-ei { display: inline-flex; vertical-align: middle; }
  .fes-ei .fes-ico.inl { margin-right: .12em; }
  .fes-howto .ic.num { font-family: Consolas,"Courier New",monospace; font-size: 19px; font-weight: 900; color: var(--hc); }
  .fes-howto .tx { color: #fff; font-weight: 800; font-size: clamp(15px, 3.4vw, 20px); line-height: 1.5; text-align: left; }
  .fes-howto kbd { display: inline-block; min-width: 1.75em; margin: 0 .12em; padding: 0 .4em; border-radius: 7px; font: 900 .86em Consolas,"Courier New",monospace; text-align: center; color: #fff;
    background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.6); border-bottom-width: 3px; vertical-align: .08em; }
  .fes-howto .ok { display: block; width: min(100%, 320px); margin: 16px auto 0; padding: 14px 20px; font-size: clamp(18px, 3.6vw, 22px); }
  .fes-howto .bar { height: 4px; margin: 14px auto 0; width: min(100%, 320px); border-radius: 99px; background: rgba(255,255,255,.12); overflow: hidden; }
  .fes-howto .bar i { display: block; height: 100%; background: var(--hc); box-shadow: 0 0 8px var(--hc); transform-origin: left; animation: fesHowBar linear both; }
  @keyframes fesHowBar { from { transform: scaleX(1) } to { transform: scaleX(0) } }
  .fes-howto .note { margin-top: 8px; text-align: center; font-size: 12px; font-weight: 700; color: rgba(255,255,255,.55); }
  .fes-lite .fes-howto .box { box-shadow: 0 12px 34px rgba(0,0,0,.7); }
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
  /* ===== 2026-11-01 デザイン（ゲームセンターの筐体・ネオン管。ホーム・大画面とそろえる）。上を上書きする ===== */
  .fes-btn { border-radius: 10px; background: rgba(6,4,18,.7); border-color: rgba(160,140,255,.35); box-shadow: 0 0 0 1px rgba(0,0,0,.5), 0 4px 14px rgba(0,0,0,.4); }
  .fes-btn:hover { background: rgba(139,107,255,.3); border-color: rgba(190,170,255,.7); box-shadow: 0 0 14px rgba(139,107,255,.55); }
  #fes-overlay, .fes-overlay { background: radial-gradient(ellipse at 50% 40%, rgba(40,20,90,.55), rgba(3,2,12,.86)); }
  .fes-card { border-radius: 18px; background: linear-gradient(180deg, rgba(24,19,56,.97), rgba(9,7,26,.98)); border: 1px solid rgba(160,140,255,.32);
    box-shadow: 0 30px 80px rgba(0,0,0,.65), 0 0 0 1px rgba(0,0,0,.6), 0 0 50px rgba(139,107,255,.22), inset 0 1px 0 rgba(255,255,255,.08); }
  .fes-card::before { content: ""; position: absolute; left: 18px; right: 18px; top: 0; height: 3px; border-radius: 0 0 3px 3px; z-index: 2; pointer-events: none;
    background: linear-gradient(90deg, #5ee7ff, #8b6bff, #ff4d8d); box-shadow: 0 0 10px rgba(139,107,255,.9), 0 0 24px rgba(255,77,141,.5); }
  .fes-card.rankin::before, .fes-getcard::before { background: linear-gradient(90deg, #ffb347, #ffd36e, #ffb347); box-shadow: 0 0 12px #ffd36e, 0 0 28px rgba(255,211,110,.6); }
  .fes-getcard::before { display: none; }
  .fes-card h2 { letter-spacing: .4em; color: #bff6ff; opacity: .85; text-shadow: 0 0 10px rgba(94,231,255,.6); }
  #fes-ui .fes-card h2, #fes-ui .fes-score, #fes-ui .fes-stat b, #fes-ui .fes-rank .s, #fes-ui .fes-rank .r { font-family: Consolas,"Courier New",monospace; }
  .fes-card .fes-title { font-style: italic; }
  .fes-score { color: #fff4d0; text-shadow: 0 0 6px #fff, 0 0 22px rgba(255,211,110,.9), 0 0 48px rgba(255,170,60,.55); letter-spacing: .02em; }
  .fes-stat { background: rgba(0,0,0,.38); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; }
  .fes-stat b { color: #ffe9a8; text-shadow: 0 0 8px rgba(255,211,110,.45); }
  .fes-rank li { border-radius: 6px; }
  .fes-rank li:nth-child(odd) { background: rgba(0,0,0,.3); }
  .fes-act { border-radius: 12px; box-shadow: 0 5px 0 rgba(30,10,70,.75), 0 10px 26px rgba(120,80,255,.45); position: relative; overflow: hidden; }
  .fes-act.next { box-shadow: 0 5px 0 rgba(90,20,50,.75), 0 10px 26px rgba(255,100,120,.45); }
  .fes-act.alt { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18); box-shadow: 0 5px 0 rgba(0,0,0,.45); }
  .fes-act:active { transform: translateY(4px); box-shadow: 0 1px 0 rgba(0,0,0,.6); }
  .fes-chip { border-radius: 9px; background: rgba(0,0,0,.3); }
  .fes-chip.on { box-shadow: 0 0 0 2px rgba(255,255,255,.35) inset, 0 0 16px rgba(139,107,255,.7); }
  .fes-count .n { font-style: italic; text-shadow: 0 0 30px rgba(255,77,141,.9), .06em .06em 0 rgba(94,231,255,.6); }
  .fes-count .n.go { text-shadow: 0 0 30px rgba(255,211,110,.95), .06em .06em 0 rgba(255,77,141,.6); }
  .fes-lite .fes-count .n, .fes-lite .fes-count .n.go { text-shadow: .06em .06em 0 rgba(0,0,0,.4); }
  .fes-lite .fes-card, .fes-lite .fes-act { box-shadow: 0 5px 0 rgba(0,0,0,.5); }
  .fes-toast { border-radius: 12px; background: rgba(8,6,24,.92); border-color: rgba(160,140,255,.4); box-shadow: 0 0 20px rgba(139,107,255,.35); }
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
        const bh = el('a', { id: 'fes-home', class: 'fes-btn', href: '../index.html', title: 'ホームへ', onclick: () => FES.sfx('select') }); setBtnIcon(bh, '🏠'); ui.appendChild(bh);
        const bm = el('div', { id: 'fes-mute', class: 'fes-btn', title: 'ミュート', onclick: () => { FES.setMuted(!muted); if (!muted) FES.sfx('select'); } }); setBtnIcon(bm, muted ? '🔇' : '🔊'); ui.appendChild(bm);
        if (document.documentElement.requestFullscreen) { const bf = el('div', { id: 'fes-full', class: 'fes-btn', title: '全画面', onclick: FES.toggleFullscreen }); setBtnIcon(bf, '⛶'); ui.appendChild(bf); }
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
      if (FES.isRoomPC()) { FES.sync(); setInterval(FES.sync, 20000); armIdleReset(); armPresence(); }
      armErrorGuard();
      if (cfg.id === 'hub') armEventBanner();
      // スマホを縦に持っていると、横長のゲームは小さくなる → 横向きの案内（縦向きで作ってあるゲームは出さない）
      if (cfg.id !== 'hub' && cfg.portraitOk !== true && !['rhythm', 'typing'].includes(FES.stampBase(cfg.id)) && FES.isTouch() && global.matchMedia) {
        const mq = global.matchMedia('(orientation: portrait) and (max-width: 600px)');
        let shown = false;
        const hint = () => { if (mq.matches && !shown) { shown = true; FES.toast('📱 スマホを 横向き にすると、大きく遊べます', 3500); } };
        setTimeout(hint, 800);
        if (mq.addEventListener) mq.addEventListener('change', () => { shown = false; hint(); });
      }
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
    // 全画面にできないとき（ブラウザが許可しないなど）の失敗は無視する。ほうっておくと「おっと」のエラー画面が出てしまう
    const ignore = p => { if (p && p.catch) p.catch(() => {}); };
    try {
      if (!d.fullscreenElement) { if (d.documentElement.requestFullscreen) ignore(d.documentElement.requestFullscreen()); }
      else if (d.exitFullscreen) ignore(d.exitFullscreen());
    } catch (e) {}
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
  FES.hideResult = function () { FES.closePrizeGet(); if (overlay) { overlay.remove(); overlay = null; } document.querySelectorAll('.fes-confetti').forEach(c => c.remove()); };

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
      lbl.innerHTML = `🎟 スタンプ <b>${n} / ${games.length}</b>` + (cardNow.done ? '　🏅 <b>殿堂入り！</b>' : '');
      const row = el('div', { class: 'fes-stamps' });
      games.forEach(g => {
        const on = !!have[g.id];
        const isNew = st && st.added && FES.stampBase(cfg.id) === g.id;
        row.appendChild(el('div', { class: 'fes-stamp' + (on ? ' on' : '') + (isNew ? ' new' : ''), style: `--c:${g.accent || '#ff4d8d'}`, text: g.icon || '★', title: g.title || '' }));
      });
      card.appendChild(lbl); card.appendChild(row);
      // 景品のはしご（スタンプ何個で何がもらえるか）と、つぎの景品まであと何個か
      const ladder = FES.prizeLadder(cardNow);
      if (ladder.length) {
        // ステージの地図: 線の上に景品がならび、いまのスタンプの数まで光る
        const nx = FES.nextPrize(cardNow), max = Math.max(...ladder.map(x => x.need || 0), 1);
        const track = el('div', { class: 'fes-track' }, [el('div', { class: 'rail' }), el('div', { class: 'fill', style: `width:${Math.min(100, n / max * 100)}%` })]);
        ladder.forEach(x => {
          const pos = x.need ? Math.max(6, Math.min(94, x.need / max * 100)) : 97;
          track.appendChild(el('div', { class: 'node' + (x.done ? ' done' : '') + (nx && nx.id === x.id ? ' next' : ''), style: `left:${pos}%`, title: x.title }, [
            el('i', { text: x.icon }), el('span', {}, [el('b', { text: x.need ? `×${x.need}` : '🎯' }), document.createTextNode(x.title.replace('NEON FESTA ', '').replace('殿堂入りの', ''))])]));
        });
        card.appendChild(track);
        if (nx) card.appendChild(el('div', { class: 'fes-next' }, [document.createTextNode('🎁 あと '), el('b', { text: String(nx.rest) }), document.createTextNode(` 個で ${nx.icon} ${nx.title}！`)]));
      }
      // 会場の PC だけ: 手でわたす景品の案内（もらえることが決まったあと、ずっと出しておく）
      if (FES.isRoomPC()) card.appendChild(el('div', { class: 'fes-stamp-lbl', html: cardNow.done ? '📜 <b>スタッフを呼んでね！</b> 殿堂入りの表彰状をもらえるよ' : '🌟 帰るときに <b>出口で NEON FESTA シール</b> をもらってね' }));
      // 新しくもらえるようになった景品は、結果画面の上に大きく出す（スタンプの音のあと）
      const freshP = FES.claimPrizes(FES.stampCard());
      if (freshP.length) setTimeout(() => { if (overlay) FES.showPrizeGet(freshP); }, st && st.complete ? 2200 : 1400);
      if (st && st.added) setTimeout(() => { FES.sfx('stamp'); FES.vibrate(30); }, 650);
      if (st && st.complete) setTimeout(() => { FES.sfx('powerup'); FES.toast(`🎉 スタンプ ${FES.hallNeed()} 個で 殿堂入り！`, 4000); confetti(4000); }, 1300);
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
        card.appendChild(el('div', { class: 'fes-prize', style: 'cursor:pointer', text: `🎁 もらった景品：${ep.map(p => p.icon + ' ' + p.title).join('　')}（タップで QR をもう一度）`, onclick: () => FES.showPrizeGet(FES.prizeLadder().filter(x => x.kind === 'qr' && x.done), { quiet: true }) }));
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
        li.appendChild(el('span', { class: 'r g' + (i + 1), text: i < 3 ? (i + 1) + '位' : (i + 1) + '.' }));
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
    if (games.length && cardNow) {
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
      // 景品ゲットの画面が出ているときは、Enter/Space で閉じるだけ（うっかりリトライしない）
      if (prizeEl && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) { e.preventDefault(); FES.closePrizeGet(); return; }
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
  // 殿堂入り（表彰状）に必要なスタンプの数。15 本全部はきついので 8 個（2026/10/23 決定）。ゲームが 8 本より少なければ全部
  const HALL_NEED = 8;
  FES.hallNeed = () => { const t = FES.stampTotal(); return t > 0 ? Math.min(HALL_NEED, t) : 0; };
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
    const total = FES.stampTotal(), need = FES.hallNeed();
    if (c.stamps[base]) return { card: c, added: false, count: Object.keys(c.stamps).length, total, complete: false };
    // 殿堂入りのあとも、のこりのゲームのスタンプは押せる（殿堂の記録は 1 回だけ）
    c.stamps[base] = Date.now();
    const count = Object.keys(c.stamps).length;
    let complete = false;
    if (!c.done && need > 0 && count >= need) {
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
    { id: 'complete', icon: '🏅', name: '殿堂入り', desc: 'スタンプを 8 個あつめた', check: c => !!c.done },
    { id: 'all', icon: '👑', name: 'パーフェクト', desc: '全部のゲームを遊んだ', check: (c, n, total) => total > 0 && n >= total },
    { id: 'rankS', icon: '💎', name: 'Sランク', desc: 'どれかのゲームで ランク S', check: c => Object.values(c.grades || {}).includes('S') },
    { id: 'rankA3', icon: '🔥', name: 'A以上 ×3', desc: '3つのゲームで ランク A 以上', check: c => Object.values(c.grades || {}).filter(g => g === 'S' || g === 'A').length >= 3 },
    { id: 'allB', icon: '🌈', name: 'オールB以上', desc: '全部のゲームで ランク B 以上', check: c => FES.games().length > 0 && FES.games().every(g => 'SAB'.includes((c.grades || {})[g.id] || 'x')) },
    { id: 'versus', icon: '⚔️', name: '対戦デビュー', desc: '対戦ゲーム（ホッケー / デュエル）を遊んだ', check: c => !!(c.stamps.duel || c.stamps.hockey) },
    { id: 'speed', icon: '⚡', name: 'スピードラン', desc: '10分以内に殿堂入り', check: c => !!c.done && (c.done - c.started) <= 10 * 60000 },
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
    { id: 'blitz', title: 'Block Blitz Arena', desc: 'ブロックパズル × オンライン対戦。1v1 ランクマッチ・2v2・レイドボス', icon: '🧩', url: 'https://block-blitz-arena.onrender.com/', cond: 'n3' },
    { id: 'core', title: 'コア工場タイクーン', desc: '施設を建ててコインを稼ぎ、敵からコアを守るタイクーン × 防衛', icon: '🏭', url: 'https://core-factory-tycoon.onrender.com/', cond: 'n5' },
  ];
  // 条件 'nN' = スタンプ N 個（2026/10/23 に「みんながもらえるように」ミッション・全部 から変更）
  const COND_LABEL = { any: '1回でも遊んだ人みんな', n3: 'スタンプ 3 個（ゲームを 3 つ遊ぶ）', n5: 'スタンプ 5 個（ゲームを 5 つ遊ぶ）', mission: '今日のミッションを全部クリア', complete: '殿堂入り（スタンプ 8 個）', off: '配らない' };
  FES.prizeConds = () => Object.keys(COND_LABEL);
  FES.prizeCondLabel = c => COND_LABEL[c] || c;
  FES.defaultPrizes = () => DEFAULT_PRIZES.map(p => Object.assign({}, p));
  // 前の既定（ミッション → Block Blitz、殿堂入り → コア工場）のまま保存してある PC は、新しい既定に1回だけ置きかえる
  if (!LS.get('fes:prizes:v2', false)) {
    const old = LS.get(PRIZES_KEY, null);
    if (Array.isArray(old)) {
      old.forEach(p => { if (p.id === 'blitz' && p.cond === 'mission') p.cond = 'n3'; if (p.id === 'core' && p.cond === 'complete') p.cond = 'n5'; });
      LS.set(PRIZES_KEY, old);
    }
    LS.set('fes:prizes:v2', true);
  }
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
  /** 条件に必要なスタンプの数（スタンプの数で決まらない条件は 0） */
  const condNeed = cond => cond === 'any' ? 1 : /^n\d+$/.test(cond) ? +cond.slice(1) : 0;
  const condMet = (cond, c) => { const n = Object.keys(c.stamps || {}).length, need = condNeed(cond); return need ? n >= need : cond === 'mission' ? FES.missionsDone(c) : cond === 'complete' ? !!c.done : false; };
  /** いまのカードでもらえる景品の一覧 */
  FES.eligiblePrizes = function (c) { c = c || FES.stampCard(); if (!c) return []; return FES.prizes().filter(p => p.url && condMet(p.cond, c)); };
  FES.prizeEligible = c => FES.eligiblePrizes(c).length > 0;

  /**
   * 景品のはしご（スタンプの数の順）。[{ id, kind:'hand'|'qr', icon, title, need, done, prize? }]
   * シールと表彰状は手でわたすので会場の PC だけに出す。ミッション条件の QR は数で並べられないので最後。
   */
  FES.prizeLadder = function (c) {
    c = c || FES.stampCard() || { stamps: {} };
    const total = FES.stampTotal(), list = [];
    if (FES.isRoomPC()) list.push({ id: 'sticker', kind: 'hand', icon: '🌟', title: 'NEON FESTA シール', need: 1, how: '帰るときに 出口でスタッフからもらってね' });
    FES.prizes().filter(p => p.url && p.cond !== 'off').forEach(p => {
      const need = p.cond === 'complete' ? FES.hallNeed() : condNeed(p.cond);
      list.push({ id: p.id, kind: 'qr', icon: p.icon || '🎁', title: p.title, need: need || 0, cond: p.cond, prize: p });
    });
    if (FES.isRoomPC()) list.push({ id: 'award', kind: 'hand', icon: '📜', title: '殿堂入りの表彰状', need: FES.hallNeed(), cond: 'complete', how: 'スタッフを呼んでね！ 名前とタイムを書いてわたします' });
    list.forEach(x => { x.done = x.kind === 'qr' ? condMet(x.cond, c) : x.id === 'award' ? !!c.done : Object.keys(c.stamps || {}).length >= 1; });
    return list.sort((a, b) => (a.need || 999) - (b.need || 999));
  };
  /** つぎにもらえる景品（数で決まるもの）と、あと何個か。もう無ければ null */
  FES.nextPrize = function (c) {
    c = c || FES.stampCard() || { stamps: {} };
    const n = Object.keys(c.stamps || {}).length;
    const x = FES.prizeLadder(c).find(x => !x.done && x.need > 0);
    return x ? Object.assign({ rest: Math.max(1, x.need - n) }, x) : null;
  };
  /** 新しくもらえるようになった景品を返し、カードに「もう見せた」と記録する */
  FES.claimPrizes = function (c) {
    c = c || FES.stampCard(); if (!c) return [];
    c.prizes = c.prizes || {};
    const fresh = FES.prizeLadder(c).filter(x => x.done && !c.prizes[x.id]);
    fresh.forEach(x => { c.prizes[x.id] = Date.now(); });
    if (fresh.length) LS.set(STAMP_KEY, c);
    return fresh;
  };

  /* ------------------------------------------------------------ 景品ゲットの画面（結果画面の上に大きく出す） */
  // QR を描く qrcode.js は common.js と同じフォルダにある。ゲームのページでは必要になったときだけ読みこむ
  const SCRIPT_DIR = (document.currentScript && document.currentScript.src || '').replace(/[^/]*$/, '');
  function loadQR(cb) {
    if (global.qrcode) return cb();
    const s = document.createElement('script');
    s.src = SCRIPT_DIR + 'qrcode.js'; s.onload = cb; s.onerror = cb;
    document.head.appendChild(s);
  }
  function qrSvg(url) {
    try { const qr = global.qrcode(0, 'M'); qr.addData(url); qr.make(); return qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true }); }
    catch (e) { return ''; }
  }
  let prizeEl = null;
  FES.closePrizeGet = function () { if (prizeEl) { prizeEl.remove(); prizeEl = null; } };
  /** items: claimPrizes の戻り値 */
  FES.showPrizeGet = function (items, opts) {
    if (!items || !items.length) return;
    ensureUI(); FES.closePrizeGet(); opts = opts || {};
    const card = el('div', { class: 'fes-card fes-getcard' });
    card.appendChild(el('div', { class: 'fes-get-k', text: 'ITEM GET!' }));
    card.appendChild(el('div', { class: 'fes-get-big', text: '🎁 景品ゲット！' }));
    const list = el('div', { class: 'fes-get-list' });
    items.forEach(x => {
      const box = el('div', { class: 'fes-get-item ' + x.kind, style: `--gc:${x.id === 'sticker' ? '#ffd36e' : x.id === 'award' ? '#ff4d8d' : '#5ee7ff'}` });
      box.appendChild(el('div', { class: 'fes-get-ic', text: x.icon }));
      box.appendChild(el('div', { class: 'fes-get-t', text: x.title }));
      if (x.kind === 'qr') {
        if (x.prize.desc) box.appendChild(el('div', { class: 'fes-get-d', text: x.prize.desc }));
        const url = FES.prizeQrUrl(x.prize);
        const qbox = el('div', { class: 'fes-get-qr', text: '…' });
        box.appendChild(qbox);
        loadQR(() => { const svg = global.qrcode ? qrSvg(url) : ''; if (svg) qbox.innerHTML = svg; else { qbox.remove(); box.appendChild(el('div', { class: 'fes-get-d', text: 'QR が出ないときは 🏠 ホーム画面で見られます' })); } });
        box.appendChild(el('div', { class: 'fes-get-how', text: '📱 スマホのカメラで読んでね' }));
        if (FES.isTouch()) box.appendChild(el('a', { class: 'fes-act alt fes-get-open', href: url, target: '_blank', rel: 'noopener', text: 'このスマホで開く' }));
      } else {
        box.appendChild(el('div', { class: 'fes-get-how', text: x.how }));
      }
      list.appendChild(box);
    });
    card.appendChild(list);
    const nx = FES.nextPrize();
    if (nx) {
      const bar = el('i', { style: 'width:0%' });
      card.appendChild(el('div', { class: 'fes-get-next' }, [document.createTextNode('NEXT ▶ あと '), el('b', { text: String(nx.rest) }), document.createTextNode(` 個で ${nx.icon} ${nx.title}`), el('div', { class: 'fes-get-bar' }, [bar])]));
      setTimeout(() => { bar.style.width = `${Math.min(100, (nx.need - nx.rest) / nx.need * 100)}%`; }, 60);
    }
    if (items.some(x => x.kind === 'qr')) card.appendChild(el('div', { class: 'fes-get-note', text: 'あとで読むときは 🏠 ホーム画面の「🎁 景品のQRコードを見る」' }));
    const ok = el('button', { class: 'fes-act', text: 'OK', onclick: () => { FES.sfx('select'); FES.closePrizeGet(); } });
    card.appendChild(el('div', { class: 'fes-actions' }, [ok]));
    prizeEl = el('div', { class: 'fes-overlay fes-get', style: 'z-index:9300' }, [el('div', { class: 'fes-get-rays' }), card]);
    prizeEl.addEventListener('click', e => { if (e.target === prizeEl) FES.closePrizeGet(); });
    ui.appendChild(prizeEl);
    if (!opts.quiet) { FES.sfx('fanfare'); FES.vibrate([30, 40, 80]); confetti(3500); }
  };
  FES.prizeGetOpen = () => !!prizeEl;
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
