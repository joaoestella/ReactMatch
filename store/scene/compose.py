import json, os
S = os.path.dirname(os.path.abspath(__file__))
INTER = open(os.environ['INTER_CSS']).read() if os.environ.get('INTER_CSS') else ''
BALL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" style="vertical-align:-3px;margin-right:6px"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l4 2.9-1.5 4.6h-5L8 10.4z"/></svg>'
I = lambda d: f'<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#b69cff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">{d}</svg>'
PAUSE = I('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>')
LIVE = I('<circle cx="12" cy="12" r="3" fill="#b69cff"/><path d="M7.5 7.5a6.5 6.5 0 0 0 0 9M16.5 7.5a6.5 6.5 0 0 1 0 9M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8"/>')
TUNE = I('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>')
LOCK = I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')
TXT = {
 'pt': {
  'tabs': ('AO VIVO | Leões x Tigres – Final', 'REACT AO VIVO: Leões x Tigres'),
  'chips': [BALL + 'Feito para futebol', 'Funciona com uma tela só', '100% no seu computador'],
  's1': ('Futebol + react<br>no mesmo segundo', 'O react ou a live acompanham o jogo sozinhos, com a cam do streamer no canto da tela.'),
  's2': ('Toque no jogo.<br>Toque no react.<br>Pronto.', 'O ReactMatch lista suas abas e encontra sozinho o relógio de cada vídeo.'),
  's3': ('A cam do react<br>em cima do jogo', 'Até em tela cheia. Escolha o canto, o tamanho e o volume de cada um.'),
  's4': ('Uma tela só?<br>Sem problema.', 'Deixe o react em segundo plano. Ao sincronizar, a aba dele aparece por 2 segundos para ler o relógio e tudo volta.'),
  's4card': ('Sincronizado', 'Diferença: 0,1 s · o vídeo 2 está em segundo plano'),
  's5': ('Intervalo, live atrasada, anúncio: ele segura.', ''),
  'feats': [(PAUSE, 'Intervalo', 'Mantém a sincronia, sem pular 45 minutos.'), (LIVE, 'Ao vivo', 'Live atrasada? Ele pausa o jogo pelo tempo certo.'), (TUNE, 'Ajuste fino', 'Meio segundo para lá ou para cá.'), (LOCK, 'Privado', 'Sem conta, sem servidor: tudo no seu PC.')],
 },
 'en': {
  'tabs': ('LIVE | Lions vs Tigers – Cup Final', 'LIVE REACT: Lions vs Tigers'),
  'chips': [BALL + 'Made for football', 'Works with one screen', '100% on your device'],
  's1': ('Football + reaction,<br>same second', 'The reaction or live stream follows the game by itself, with the streamer’s cam in a corner.'),
  's2': ('Tap the game.<br>Tap the react.<br>Done.', 'ReactMatch lists your tabs and finds the clock in each video by itself.'),
  's3': ('The reaction cam<br>on top of the game', 'Even in full screen. Pick the corner, the size and each one’s volume.'),
  's4': ('Just one screen?<br>No problem.', 'Leave the reaction in the background. When syncing, its tab shows for 2 seconds to read the clock, then everything goes back.'),
  's4card': ('In sync', 'Difference: 0.1 s · video 2 is in the background'),
  's5': ('Halftime, late lives, ads: it holds on.', ''),
  'feats': [(PAUSE, 'Halftime', 'Stays in sync, no 45-minute jump.'), (LIVE, 'Live', 'Stream running late? It pauses the game for exactly the gap.'), (TUNE, 'Fine tuning', 'Half a second either way.'), (LOCK, 'Private', 'No account, no server: all on your computer.')],
 },
}
BASE = f'''<style>{INTER}
*{{box-sizing:border-box;margin:0}}
html,body{{width:1280px;height:800px;overflow:hidden}}
body{{font-family:InterV,sans-serif;color:#eef2f9;background:radial-gradient(800px 500px at 0% 100%,#22c55e2e,transparent 60%),radial-gradient(700px 520px at 100% 0%,#8b5cf633,transparent 60%),#0a0e16}}
.left{{position:absolute;left:64px;top:0;bottom:0;width:430px;display:flex;flex-direction:column;justify-content:center}}
.brand{{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:800;margin-bottom:30px}} .brand b{{color:#b69cff}}
.brand img{{width:44px;height:44px}}
h1{{font-size:50px;line-height:1.05;letter-spacing:-.03em;font-weight:850}}
p.sub{{margin-top:20px;font-size:20px;line-height:1.5;color:#a8b3c4}}
.chips{{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}}
.chips span{{padding:8px 13px;border-radius:999px;font-size:15px;font-weight:700;background:#ffffff0d;border:1px solid #ffffff1f}}
.chips span:first-child{{background:#22c55e22;border-color:#22c55e66;color:#86efac}}
.win{{position:absolute;border-radius:14px;overflow:hidden;background:#1f2023;box-shadow:0 30px 80px #0009,0 0 0 1px #ffffff12}}
.tabsbar{{height:40px;display:flex;align-items:flex-end;gap:6px;padding:0 12px;background:#16171a}}
.dots{{display:flex;gap:7px;align-self:center;margin-right:8px}} .dots i{{width:11px;height:11px;border-radius:50%;background:#3a3c41}}
.tab{{height:32px;max-width:300px;flex:1;background:#2b2c30;border-radius:9px 9px 0 0;display:flex;align-items:center;gap:8px;padding:0 12px;font-size:12.5px;color:#d7d9de;white-space:nowrap;overflow:hidden}}
.tab.bg{{background:transparent;color:#9aa0a6}}
.tab .fav{{width:15px;height:15px;border-radius:4px;flex:none}}
.bar{{height:42px;background:#2b2c30;display:flex;align-items:center;gap:12px;padding:0 14px}}
.omni{{flex:1;height:30px;border-radius:15px;background:#1c1d20;display:flex;align-items:center;padding:0 14px;font-size:13px;color:#c9ccd2}}
.ext{{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#8b5cf62e;box-shadow:0 0 0 2px #8b5cf6aa}} .ext img{{width:20px;height:20px}}
.shot{{display:block;width:100%}}
.panel{{position:absolute;border-radius:14px;overflow:hidden;box-shadow:0 26px 70px #000b,0 0 0 1px #ffffff1a;background:#0a0e16}}
.panel img{{display:block;width:100%}}
</style>'''
def browser(lang, x, y, w, img, active=0, sound=None):
    t = TXT[lang]['tabs']
    SPK = ' <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#c7cad1" stroke-width="2.2" style="margin-left:4px"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>'
    colors = ['#1d4ed8', '#7c3aed']
    tabs = ''.join('<div class="tab ' + ('' if i == active else 'bg') + f'"><i class="fav" style="background:{colors[i]}"></i>{name}' + (SPK if sound == i else '') + '</div>' for i, name in enumerate(t))
    url = ['futplay.tv/live/leoes-x-tigres', 'resenhalive.tv/react'][active]
    return f'<div class="win" style="left:{x}px;top:{y}px;width:{w}px"><div class="tabsbar"><div class="dots"><i></i><i></i><i></i></div>{tabs}</div><div class="bar"><div class="omni"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#9aa0a6" stroke-width="2.4" style="margin-right:8px"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>{url}</div><div class="ext"><img src="icon.png"></div></div><img class="shot" src="{img}"></div>'
def panel(x, y, w, img, crop=None):
    h = f'height:{crop}px;' if crop else ''
    return f'<div class="panel" style="left:{x}px;top:{y}px;width:{w}px;{h}"><img src="{img}"></div>'
def left(lang, head, sub, chips=False, extra=''):
    c = '<div class="chips">' + ''.join(f'<span>{x}</span>' for x in TXT[lang]['chips']) + '</div>' if chips else ''
    s = f'<p class="sub">{sub}</p>' if sub else ''
    return f'<div class="left"><div class="brand"><img src="icon.png"><span>React<b>Match</b></span></div><h1>{head}</h1>{s}{c}{extra}</div>'
jobs = []
for lang in TXT:
    T = TXT[lang]
    L = lang
    slides = {
      '1-hero': left(L, *T['s1'], chips=True) + browser(L, 520, 70, 720, f'game-pip-{L}.png') + panel(1010, 390, 250, f'panel-synced-{L}.png', 380),
      '2-pick': left(L, *T['s2']) + panel(540, 60, 320, f'panel-pick-{L}.png', 680) + f'<div style="position:absolute;left:878px;top:380px;font-size:44px;color:#b69cff">→</div>' + panel(930, 60, 320, f'panel-synced-{L}.png', 680),
      '3-cam': left(L, *T['s3']) + browser(L, 520, 120, 720, f'game-menu-{L}.png'),
      '4-onescreen': left(L, *T['s4']) + browser(L, 520, 120, 720, f'game-pip-{L}.png', 0, 1) + f'<div style="position:absolute;left:600px;top:560px;padding:16px 20px;border-radius:14px;background:#121925;border:1px solid #263044;box-shadow:0 20px 60px #000a;font-size:17px"><b style="display:flex;align-items:center;gap:9px;font-size:20px"><i style="width:11px;height:11px;border-radius:50%;background:#5eeaa0;box-shadow:0 0 0 5px #5eeaa022"></i>{T["s4card"][0]}</b><div style="margin-top:6px;color:#9aa8bb">{T["s4card"][1]}</div></div>',
      '5-features': left(L, f'<span style="font-size:42px">{T["s5"][0]}</span>', '', extra='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:30px;width:560px">' + ''.join(f'<div style="padding:16px;border-radius:14px;background:#121925;border:1px solid #263044"><div style="font-size:24px">{i}</div><div style="font-weight:800;font-size:18px;margin-top:6px">{a}</div><div style="color:#9aa8bb;font-size:15px;margin-top:4px;line-height:1.4">{b}</div></div>' for i, a, b in T['feats']) + '</div>') + panel(900, 60, 330, f'panel-synced-{L}.png', 680),
    }
    for name, body in slides.items():
        fn = f'screenshot-{name}-{lang}'
        open(f'{S}/html/{fn}.html', 'w').write(f'<!doctype html><meta charset=utf-8>{BASE}<body>{body}</body>')
        jobs.append(fn)
# promo tiles
def promo(w, h, head, sub, size):
    subhtml = f'<div style="font-size:{size*0.4}px;color:#9aa8bb;margin-top:{size//4}px">{sub}</div>' if sub else ''
    return (f'<!doctype html><meta charset=utf-8>{BASE}<style>html,body{{width:{w}px;height:{h}px}}</style>'
            f'<body style="display:flex;align-items:center;gap:{size//2}px;padding:0 {size}px"><img src="icon.png" style="width:{size*3}px;height:{size*3}px;filter:drop-shadow(0 18px 40px #0008)">'
            f'<div><div style="font-size:{size*1.2}px;font-weight:850;letter-spacing:-.02em">React<span style="color:#b69cff">Match</span></div>'
            f'<div style="font-size:{size*0.62}px;color:#cfd6e2;margin-top:{size//5}px;line-height:1.25;font-weight:700">{head}</div>{subhtml}</div></body>')
open(f'{S}/html/promo-small-440x280.html', 'w').write(promo(440, 280, 'Football + reaction,<br>same second', '', 34))
open(f'{S}/html/promo-marquee-1400x560-en.html', 'w').write(promo(1400, 560, 'Football + reaction, same second', 'The streamer’s cam over the game, synced by itself.', 70))
open(f'{S}/html/promo-marquee-1400x560-pt.html', 'w').write(promo(1400, 560, 'Futebol + react no mesmo segundo', 'A cam do streamer em cima do jogo, sincronizada sozinha.', 70))
open(f'{S}/html/social-1280x640.html', 'w').write(promo(1280, 640, 'Football + reaction, same second', 'Syncs a reaction or live with the game you watch, the streamer’s cam on top. 100% on your computer.', 60))
json.dump(jobs, open(f'{S}/html/jobs.json', 'w'))
print(len(jobs))
