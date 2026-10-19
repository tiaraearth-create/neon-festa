"""
Write MIDI-based charts into C:/dev/bunkasai-game-center/games/music/charts.js (window.RHYTHM_EXT_SONGS),
in the exact format 開発用/譜面ツール/make-chart.js produces: charts = [easy, normal, hard], each a list of 3 variants of [t, lane, end].
Times are shifted by `trimmed` (seconds cut from the start of the audio).
"""
import json, re, os, random
from collections import defaultdict, Counter
base = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_charts.py'), encoding='utf-8').read().split('W = "./"')[0]
exec(base)   # load(), lead_from_track(), lead_topline(), drums_from(), make_chart(), RULES, DIFF_IDS, step_of, bar_of

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "games", "music", "charts.js")

def make_variants(M, lead, drums, diff, nbars, bounds, trimmed, nvar=3):
    """3 variants: different 4-bar window alignment for the pitch->lane map + different jack-avoid direction"""
    out = []
    for v in range(nvar):
        random.seed(100 + v)
        # shift window boundaries by v bars (0,1,2) so the lane mapping differs per variant
        tpb = M['tpb']
        def shifted_lead():
            return [(s + v * tpb * 4, n, d) for s, n, d in lead]
        notes = make_chart(M, shifted_lead(), [(s + v * tpb * 4, k) for s, k in drums], diff, nbars + v, [(b + v, n) for b, n in bounds])
        shift_sec = M['t2s'](v * tpb * 4) if v else 0.0
        res = []
        for t, lane, end, src in notes:
            t2 = round(t - shift_sec - trimmed, 3); e2 = round(end - shift_sec - trimmed, 3) if end else 0
            if t2 < 0.25: continue
            if v == 2: lane = 3 - lane                      # variant 3: mirrored pitch direction
            res.append([t2, lane, e2])
        out.append(res)
    return out

SONGS = [
    dict(id='lastbreath', name='ラストブレスサンズ', genre='バトル', bpm=150, theme='cat2', hex='#ff3b5c', color=[255, 59, 92],
         mini_bars=68,
         audio='music/lastbreath.m4a', trimmed=24.8, length=234.0, midi='lastbreath_src.mid', lead='Elec. Piano (Classic)', topline=True,
         drums='Electric Drum Kit', kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 12), ('PRE', 4), ('BUILD', 12), ('DROP1', 16), ('DROP2', 24), ('BRK', 4), ('BRIDGE', 4), ('HALF', 16), ('LIGHT', 8), ('DROP3', 12), ('BRK2', 8), ('FINAL', 20), ('OUTRO', 16), ('END', 2)]),
    dict(id='megalovania', name='メガロバニア', genre='バトル', bpm=128, theme='rock', hex='#ff7a3d', color=[255, 122, 61],
         mini_bars=36,
         audio='music/megalovania.m4a', trimmed=7.5, length=124.0, midi='megalovania_noau_ultimate.mid', lead=['Lead (ref)', 'Piano', 'Music Box'], drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 4), ('BUILD', 4), ('DROP', 8), ('THEME2', 8), ('BRIDGE', 4), ('WOBBLE', 8), ('BRK', 4), ('THEME3', 8), ('DROP2', 8), ('FINALE', 8), ('END', 4)]),
    dict(id='shanghaivania', name='シャンハイバニア', genre='バトル', bpm=189, theme='sakura', hex='#ff6ea0', color=[255, 110, 160],
         mini_bars=64,
         audio='music/shanghaivania.m4a', trimmed=0, length=204.1, midi='shanghaivania_take1.mid', lead='Violin (Classic)', drums='Electric Drum Kit', kick=(36,), snare=(40,),
         sections=[('INTRO', 8), ('A', 16), ('BREAK', 8), ('B', 32), ('BRK', 8), ('C', 32), ('BREAK', 8), ('BUILD', 8), ('FINALE', 32), ('END', 4)]),
    dict(id='badend', name='BAD END PROTOCOL', genre='NOAU', bpm=190, theme='neon', hex='#825aff', color=[130, 90, 255],
         audio='music/badend.m4a', trimmed=0, length=82.6, midi='noau_sans_theme.mid', lead=['Lead (Supersaw)', 'Piano RH'], drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 8), ('BUILD', 4), ('A', 8), ('B', 8), ('BRK', 4), ('A2', 8), ('B2', 8), ('OUTRO', 5)]),
    # --- 人気曲（Online Sequencer の打ち込み + リミックス層。メロディは全パートの最高音から抽出） ---
    dict(id='badapple', name='Bad Apple!!', genre='東方', bpm=138, theme='cat1', hex='#9fd3ff', color=[159, 211, 255],
         mini_bars=48,
         audio='music/badapple.m4a', trimmed=0, length=218.9, midi='badapple_src.mid', topline=True, floor=50,
         lead=['Piccolo', 'Flute 1', 'Flute 2', 'Bb Clarinet 1', 'Soprano Saxophone', 'Violins', '8-Bit Square Treble', 'Grand Piano Treble', 'Bb Trumpet 1', 'Alto Saxophone 1'],
         drums=['909 Drum Kit', 'Electric Drum Kit', '2023 Drum Kit'], kick=(35, 36, 27), snare=(38, 40, 37),
         sections=[('INTRO', 8), ('A', 8), ('B', 16), ('C', 16), ('BRK', 8), ('D', 4), ('E', 32), ('F', 28), ('END', 5)]),
    dict(id='worldrevolving', name='THE WORLD REVOLVING', genre='DELTARUNE', bpm=191, theme='rock', hex='#ffb347', color=[255, 179, 71],
         audio='music/worldrevolving.m4a', trimmed=0, length=103.6, midi='worldrevolving_src.mid', topline=True,
         lead=['8-Bit Square', 'Brass', 'Electric Guitar', 'Trombone (Classic)', 'Violin (Classic) 3', 'Violin', '8-Bit Sine', 'Pop Synth', 'Steel Drums', 'Violin (Classic)', 'Violin (Classic) 2'],
         drums=['2013 Drum Kit', '2023 Drum Kit', '909 Drum Kit'], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 16), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('END', 2)]),
    dict(id='bigshot', name='BIG SHOT', genre='DELTARUNE', bpm=140, theme='tas', hex='#ff4fd8', color=[255, 79, 216],
         mini_bars=52,
         audio='music/bigshot.m4a', trimmed=0, length=156.1, midi='bigshot_src.mid', topline=True,
         lead=['Flute', 'Violin (Classic)', 'Trombone (Classic)', 'Strings', 'Brass', 'Electric Guitar', 'Distortion Guitar', 'Violin (Classic) 2', '8-Bit Square', 'Grand Piano 3', 'Violin (Classic) 3', 'Lucent Choir', 'Muted E-Guitar', 'Ragtime Piano'],
         drums=['2013 Drum Kit', '2023 Drum Kit', '909 Drum Kit'], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 4), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('BRK', 4), ('E', 16), ('END', 3)]),
    # --- ボカロ（Online Sequencer の打ち込み + リミックス層） ---
    dict(id='senbonzakura', name='千本桜', genre='ボカロ', bpm=151, theme='sakura', hex='#ff8ab8', color=[255, 138, 184],
         mini_bars=56,
         audio='music/senbonzakura.m4a', trimmed=0, length=245.1, midi='senbonzakura_src.mid', topline=True, floor=60,
         lead=['Violin (Classic)', 'Grand Piano (Classic)'], drums=[], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 8), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('E', 16), ('F', 16), ('BRK', 8), ('G', 16), ('H', 16), ('END', 10)]),
    dict(id='mesmerizer', name='メズマライザー', genre='ボカロ', bpm=185, theme='neon', hex='#ff5fd2', color=[255, 95, 210],
         mini_bars=72,
         audio='music/mesmerizer.m4a', trimmed=0, length=157.5, midi='mesmerizer_src.mid', topline=True, floor=60, primary='8-Bit Sine',
         lead=['8-Bit Sine', 'Ragtime Piano', 'Grand Piano (Classic)', 'Electric Guitar'], drums=['Electric Drum Kit', '909 Drum Kit'], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 8), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('E', 16), ('F', 16), ('END', 14)]),
    dict(id='king', name='KING', genre='ボカロ', bpm=166, theme='rock', hex='#ffcc33', color=[255, 204, 51],
         mini_bars=56,
         audio='music/king.m4a', trimmed=0, length=137.4, midi='king_src.mid', topline=True, floor=58, primary='8-Bit Sawtooth',
         lead=['8-Bit Sawtooth', 'Smooth Synth (Classic)', 'Vibraphone', 'Grand Piano (Classic)'], drums=['Electric Drum Kit'], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 8), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('E', 16), ('END', 5)]),
    dict(id='venom', name='ベノム', genre='ボカロ', bpm=152, theme='cat2', hex='#b23cff', color=[178, 60, 255],
         audio='music/venom.m4a', trimmed=0, length=123.1, midi='venom_src.mid', topline=True, floor=56, primary='Violin',
         lead=['Violin', 'Distortion Guitar', 'Dist. Guitar (Classic)'], drums=['2013 Drum Kit'], kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 8), ('A', 16), ('B', 16), ('C', 16), ('D', 16), ('END', 4)]),
]

entries = []
for cfg in SONGS:
    M = load(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'midi', cfg['midi']))
    lead = lead_topline(M, cfg['lead'], cfg.get('floor', 60), cfg.get('primary')) if cfg.get('topline') else lead_from_track(M, cfg['lead'])
    drums = drums_from(M, cfg['drums'], cfg.get('kick', (35, 36)), cfg.get('snare', (38, 40)))
    nbars = sum(b for _, b in cfg['sections']); bounds = []; b0 = 0
    for name, bars in cfg['sections']: bounds.append((b0, name)); b0 += bars
    charts = [make_variants(M, lead, drums, d, nbars, bounds, cfg['trimmed']) for d in DIFF_IDS]
    for di, vs in enumerate(charts):
        c = vs[0]; cnt = [0, 0, 0, 0]
        for n in c: cnt[n[1]] += 1
        print(f"  {cfg['id']:14s} {DIFF_IDS[di]:6s}: {len(c):4d} notes (holds {sum(1 for n in c if n[2])}) x{len(vs)} variants  lanes {'/'.join(str(round(x / max(1, len(c)) * 100)) for x in cnt)}%  first {c[0][0] if c else '-'}s last {c[-1][0] if c else '-'}s")
    entry = dict(id=cfg['id'], name=cfg['name'], genre=cfg['genre'], bpm=cfg['bpm'], offset=0, start=0, trimmed=cfg['trimmed'], length=cfg['length'],
                 audio=cfg['audio'], hex=cfg['hex'], color=cfg['color'], theme=cfg['theme'], charts=charts)
    if cfg.get('mini_bars'):   # ミニ版: この小節の頭で終わる（音声はゲーム側でフェードアウト）
        entry['mini'] = round(M['t2s'](cfg['mini_bars'] * M['tpb'] * 4) - cfg['trimmed'], 2)
        print(f"   mini: {entry['mini']}s")
    entries.append(entry)

# merge with the existing list (replace same ids, keep any others)
existing = []
if os.path.exists(OUT):
    m = re.search(r'=\s*(\[[\s\S]*\]);', open(OUT, encoding='utf-8').read())
    if m: existing = json.loads(m.group(1))
ids = {e['id'] for e in entries}
final = [e for e in existing if e['id'] not in ids and os.path.exists(os.path.join(os.path.dirname(OUT), os.path.basename(e['audio'])))] + entries   # 音声が無い曲は外す
open(OUT, 'w', encoding='utf-8').write("// リズムスターズの追加曲（譜面は曲の MIDI データから生成。音声は同じフォルダの .m4a）\nwindow.RHYTHM_EXT_SONGS = " + json.dumps(final, ensure_ascii=False) + ";\n")
print('wrote', OUT, 'songs:', [e['id'] for e in final], os.path.getsize(OUT) // 1024, 'KB')
