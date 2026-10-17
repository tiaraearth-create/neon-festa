"""
Generate rhythm-game charts for NEON FESTA "Rhythm Stars" from the songs' MIDI data.
Output: E:/NEON-FESTA_ゲーム本体/games/rhythm_songs.js  (window.AUDIO_SONGS)
Chart note: [t_sec, lane(0-3), end_sec_or_0, src('mel'|'drum'|'chord')]
"""
import mido, json, math, os
from collections import Counter, defaultdict

OUT = "E:/NEON-FESTA_ゲーム本体/games/rhythm_songs.js"
DIFF_IDS = ['easy', 'normal', 'hard']

# ---------------- MIDI loading with tempo map ----------------
def load(path):
    m = mido.MidiFile(path); tpb = m.ticks_per_beat
    tempos = []
    for tr in m.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == 'set_tempo': tempos.append((t, msg.tempo))
    tempos = sorted(set(tempos)) or [(0, 500000)]
    if tempos[0][0] != 0: tempos.insert(0, (0, tempos[0][1]))
    # tick -> seconds
    segs = []; sec = 0.0
    for i, (tk, tp) in enumerate(tempos):
        segs.append((tk, sec, tp))
        if i + 1 < len(tempos): sec += (tempos[i + 1][0] - tk) * tp / 1e6 / tpb
    def t2s(tick):
        s = segs[0]
        for g in segs:
            if tick >= g[0]: s = g
        return s[1] + (tick - s[0]) * s[2] / 1e6 / tpb
    tracks = {}
    for tr in m.tracks:
        t = 0; on = {}; notes = []
        for msg in tr:
            t += msg.time
            if msg.type == 'note_on' and msg.velocity > 0: on.setdefault(msg.note, []).append(t)
            elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                if on.get(msg.note): s = on[msg.note].pop(0); notes.append((s, msg.note, t - s))
        if notes: tracks[tr.name] = sorted(notes)
    return dict(tpb=tpb, t2s=t2s, tracks=tracks, tempos=tempos)

def step_of(tick, tpb): return (tick % (tpb * 4)) / (tpb / 4)      # 0..16 within bar
def bar_of(tick, tpb): return tick // (tpb * 4)

# ---------------- lead extraction ----------------
def lead_from_track(M, name, floor=55):
    """highest note at each tick (dedupe stacked layers); name may be a list of track names"""
    names = name if isinstance(name, (list, tuple)) else [name]
    by_tick = defaultdict(list)
    for nm in names:
        for s, n, d in M['tracks'].get(nm, []):
            if n >= floor: by_tick[s].append((n, d))
    out = []
    for s in sorted(by_tick):
        n, d = max(by_tick[s]); out.append((s, n, d))
    return out
def lead_topline(M, name, floor=60):
    """per-bar ceiling threshold (accompaniment stabs removed), highest per tick"""
    tpb = M['tpb']; by_bar = defaultdict(list)
    for s, n, d in M['tracks'][name]: by_bar[bar_of(s, tpb)].append((s, n, d))
    out = []
    for b, notes in by_bar.items():
        mx = max(n for _, n, _ in notes); by_tick = defaultdict(list)
        for s, n, d in notes:
            if n >= mx - 13 and n >= floor: by_tick[s].append((n, d))
        for s in sorted(by_tick):
            n, d = max(by_tick[s]); out.append((s, n, d))
    return sorted(out)
def drums_from(M, name, kick=(35, 36), snare=(38, 40)):
    out = []
    for s, n, d in M['tracks'].get(name, []):
        if n in kick: out.append((s, 'kick'))
        elif n in snare: out.append((s, 'snare'))
        else: out.append((s, 'other'))      # hats etc.: only used for the intensity map
    return out

# ---------------- chart generation ----------------
RULES = {
    # min gap between any two notes, min hold length (steps), melody step filter, drums level
    'easy':   dict(gap=0.26, hold_steps=8, step_mod=2, drums=0, lane_gap=0.30),
    'normal': dict(gap=0.145, hold_steps=6, step_mod=1, drums=1, lane_gap=0.16),
    'hard':   dict(gap=0.11, hold_steps=4, step_mod=1, drums=2, lane_gap=0.10),
}

def intensity_by_bar(drums, tpb, nbars):
    c = Counter(bar_of(s, tpb) for s, _ in drums)
    return [c.get(b, 0) for b in range(nbars)]

def make_chart(M, lead, drums, diff, nbars, sec_bounds):
    R = RULES[diff]; tpb = M['tpb']; t2s = M['t2s']
    inten = intensity_by_bar(drums, tpb, nbars)
    notes = []   # dicts: t, lane, end, src
    # --- lane map per 4-bar window: pitch rank -> lane, with jack avoidance ---
    win = defaultdict(list)
    for s, n, d in lead: win[bar_of(s, tpb) // 4].append(n)
    lane_of = {}
    for w, ps in win.items():
        srt = sorted(ps); m = {}; L = len(srt)
        for p in sorted(set(ps)):
            lo = srt.index(p); hi = L - srt[::-1].index(p)          # instance rank range of this pitch
            m[p] = min(3, int(((lo + hi) / 2) / L * 4))
        lane_of[w] = m
    # --- melody ---
    last_t = -9; last_lane = -1; hold_until = -1; hold_lane = -1
    for s, n, d in lead:
        st = step_of(s, tpb)
        if abs(st - round(st)) > 1e-6: continue
        st = int(round(st))
        if st % R['step_mod'] != 0: continue
        t = t2s(s)
        if t - last_t < R['gap'] - 1e-9: continue
        if t < hold_until and diff == 'easy': continue           # easy: nothing during a hold
        lane = lane_of[bar_of(s, tpb) // 4][n]
        if lane == last_lane and t - last_t < R['lane_gap']: lane = lane + 1 if lane < 3 else lane - 1
        if t < hold_until and lane == hold_lane: lane = lane + 1 if lane < 3 else lane - 1
        steps_len = d / (tpb / 4)
        end = 0.0
        if steps_len >= R['hold_steps']:
            end = t2s(s + d) - (tpb / 8) * 0  # end at note end
            end = t2s(s + int(d - tpb / 8))
            if end - t < 0.3: end = 0.0
        notes.append(dict(t=t, lane=lane, end=end, src='mel'))
        if end: hold_until = end + 0.15; hold_lane = lane
        last_t = t; last_lane = lane
    # --- drums (only in intense bars) ---
    if R['drums'] > 0:
        for s, kind in drums:
            b = bar_of(s, tpb)
            if b >= nbars or inten[b] < 6: continue
            st = step_of(s, tpb)
            if abs(st - round(st)) > 1e-6: continue
            st = int(round(st))
            outer = 0 if b % 2 == 0 else 3
            if kind == 'other': continue
            if kind == 'kick':
                if not (st == 0 or (R['drums'] >= 2 and st == 8)): continue
                lane = outer
            else:
                if R['drums'] < 2 or st not in (4, 12): continue
                lane = 3 - outer
            notes.append(dict(t=t2s(s), lane=lane, end=0.0, src='drum'))
    # --- section-start chords (hard: 2 notes) ---
    if diff == 'hard':
        for (b0, name) in sec_bounds:
            if b0 <= 0 or b0 >= nbars or inten[min(b0, nbars - 1)] < 6: continue
            t = t2s(b0 * tpb * 4)
            notes.append(dict(t=t, lane=0, end=0.0, src='chord')); notes.append(dict(t=t, lane=3, end=0.0, src='chord'))
    # --- resolve: sort, per-lane spacing, hold overlaps, global density ---
    notes.sort(key=lambda x: (x['t'], x['lane']))
    out = []; last_lane_t = [-9] * 4; hold_end = [-9] * 4; last_any = -9
    for n in notes:
        l = n['lane']
        if n['src'] in ('drum', 'chord'):
            # drop drums colliding with melody (same instant, any lane -> keep melody; or same lane too close)
            if any(abs(o['t'] - n['t']) < 0.05 and o['src'] == 'mel' for o in out[-6:]) and n['src'] == 'drum': continue
            if n['t'] - last_any < R['gap'] * 0.9 and n['src'] == 'drum': continue
        if n['t'] < hold_end[l] + 0.15:
            if n['src'] != 'mel': continue
            # shorten the previous hold in this lane
            for o in reversed(out):
                if o['lane'] == l and o['end']:
                    o['end'] = max(o['t'] + 0.3, n['t'] - 0.2)
                    if o['end'] - o['t'] < 0.3: o['end'] = 0.0
                    break
        if n['t'] - last_lane_t[l] < R['lane_gap'] - 1e-9 and n['src'] != 'mel': continue
        if n['t'] - last_lane_t[l] < 0.09: continue
        out.append(n); last_lane_t[l] = n['t']; hold_end[l] = n['end'] if n['end'] else -9
        if n['src'] == 'mel': last_any = n['t']
    # chords: at most 2 simultaneous
    i = 0
    while i < len(out):
        j = i + 1
        while j < len(out) and abs(out[j]['t'] - out[i]['t']) < 1e-6: j += 1
        if j - i > 2: del out[i + 2:j]; j = i + 2
        i = j
    return [[round(n['t'], 3), n['lane'], round(n['end'], 3) if n['end'] else 0, n['src']] for n in out]

def song(cfg):
    M = load(cfg['midi']); tpb = M['tpb']
    lead = lead_topline(M, cfg['lead'], cfg.get('floor', 60)) if cfg.get('topline') else lead_from_track(M, cfg['lead'])
    drums = drums_from(M, cfg['drums'], cfg.get('kick', (35, 36)), cfg.get('snare', (38, 40)))
    nbars = sum(b for _, b in cfg['sections'])
    bounds = []; b0 = 0
    for name, bars in cfg['sections']: bounds.append((b0, name)); b0 += bars
    charts = {d: make_chart(M, lead, drums, d, nbars, bounds) for d in DIFF_IDS}
    stats = {d: (len(charts[d]), sum(1 for n in charts[d] if n[2]), sum(1 for n in charts[d] if n[3] != 'mel')) for d in DIFF_IDS}
    print(f"{cfg['id']:14s} lead={len(lead):4d} drums={len(drums):4d} bars={nbars:3d} " + ' '.join(f"{d}:{s[0]}n/{s[1]}h/{s[2]}d" for d, s in stats.items()))
    # peak density check (notes per second over 2s windows) for hard
    ts = [n[0] for n in charts['hard']]; peak = 0
    for i, t in enumerate(ts):
        k = i
        while k < len(ts) and ts[k] < t + 2: k += 1
        peak = max(peak, (k - i) / 2)
    print(f"   hard peak density {peak:.1f} notes/s")
    d = dict(id=cfg['id'], name=cfg['name'], genre=cfg['genre'], bpm=cfg['bpm'], theme=cfg['theme'], color=cfg['color'], hex=cfg['hex'],
             audio=cfg['audio'], length=cfg['length'], gain=cfg.get('gain', 0.9), inst={},
             sections=[dict(name=n, bars=b) for n, b in cfg['sections']], charts=charts)
    if cfg.get('bpmLabel'): d['bpmLabel'] = cfg['bpmLabel']
    if cfg.get('tempo'): d['tempo'] = cfg['tempo']
    if cfg.get('sudden'): d['sudden'] = True
    if cfg.get('approach'): d['approach'] = cfg['approach']
    return d

W = "./"
SONGS = [
    dict(id='shanghai', name='シャンハイバニア -NOAU REMIX-', genre='INK SANS REMIX', bpm=189, theme='sakura', color=[255, 110, 160], hex='#ff6ea0',
         audio='rhythm/shanghaivania.mp3', length=204.1, midi=W + 'shanghaivania_take1.mid', lead='Violin (Classic)', drums='Electric Drum Kit', kick=(36,), snare=(40,),
         sections=[('INTRO', 8), ('A', 16), ('BREAK', 8), ('B', 32), ('BRK', 8), ('C', 32), ('BREAK', 8), ('BUILD', 8), ('FINALE', 32), ('END', 4)]),
    dict(id='enigma', name='An Enigmatic Encounter -NOAU REMIX-', genre='LAST BREATH REMIX', bpm=150, theme='tas', color=[255, 60, 120], hex='#ff3c78',
         audio='rhythm/enigmatic.mp3', length=258.8, midi=W + 'lastbreath_src.mid', lead='Elec. Piano (Classic)', topline=True, drums='Electric Drum Kit', kick=(35, 36), snare=(38, 40),
         sections=[('INTRO', 12), ('PRE', 4), ('BUILD', 12), ('DROP1', 16), ('DROP2', 24), ('BRK', 4), ('BRIDGE', 4), ('HALF', 16), ('LIGHT', 8), ('DROP3', 12), ('BRK2', 8), ('FINAL', 20), ('OUTRO', 16), ('END', 2)]),
    dict(id='megault', name='MEGALOVANIA -NOAU ULTIMATE-', genre='SANS REMIX', bpm=128, theme='cat2', color=[255, 40, 90], hex='#ff285a',
         audio='rhythm/megalovania.mp3', length=131.5, midi=W + 'megalovania_noau_ultimate.mid', lead='Lead (ref)', drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 4), ('BUILD', 4), ('DROP', 8), ('THEME2', 8), ('BRIDGE', 4), ('WOBBLE', 8), ('BRK', 4), ('THEME3', 8), ('DROP2', 8), ('FINALE', 8), ('END', 4)]),
    dict(id='sudden', name='NO TURNING BACK', genre='SUDDEN CHANGES P3', bpm=132, bpmLabel='132→160', theme='cat1', color=[80, 140, 255], hex='#508cff', sudden=True,
         tempo=[dict(bar=0, bpm=132), dict(bar=24, bpm=150), dict(bar=32, bpm=100), dict(bar=36, bpm=160)],
         audio='rhythm/sudden.mp3', length=86.5, midi=W + 'sudden_changes_p3.mid', lead='Lead (ref)', drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 4), ('RIFF', 8), ('HALF', 4), ('THEME', 8), ('FAST', 8), ('SLOW', 4), ('FINALE', 8), ('END', 3)]),
    dict(id='finalbreath', name='THE FINAL BREATH', genre='LAST BREATH P3', bpm=150, bpmLabel='150→165', theme='tas', color=[255, 90, 60], hex='#ff5a3c',
         tempo=[dict(bar=0, bpm=150), dict(bar=36, bpm=165)],
         audio='rhythm/finalbreath.mp3', length=79.1, midi=W + 'last_breath_p3.mid', lead='Lead (ref)', drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 8), ('DROP', 8), ('CHORUS', 8), ('HELL', 8), ('BRK', 4), ('FINALE', 8), ('OUTRO', 4)]),
    dict(id='badend', name='BAD END PROTOCOL', genre='NOAU ORIGINAL', bpm=190, theme='neon', color=[130, 90, 255], hex='#825aff',
         audio='rhythm/badend.mp3', length=82.6, midi=W + 'noau_sans_theme.mid', lead='Lead (Supersaw)', drums='Drums', kick=(36,), snare=(38,),
         sections=[('INTRO', 8), ('BUILD', 4), ('A', 8), ('B', 8), ('BRK', 4), ('A2', 8), ('B2', 8), ('OUTRO', 5)]),
]
defs = [song(c) for c in SONGS]
js = "/* NEON FESTA - Rhythm Stars: audio songs (NOAU remixes/originals). Generated by make_charts.py from the songs' MIDI data.\n   chart note = [time_sec, lane, hold_end_sec_or_0, source] */\nwindow.AUDIO_SONGS = " + json.dumps(defs, ensure_ascii=False, separators=(',', ':')) + ";\n"
open(OUT, 'w', encoding='utf-8').write(js)
print('wrote', OUT, len(js) // 1024, 'KB')
