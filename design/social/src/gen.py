import math, random, json, base64, os
import pathlib
PUB=str(pathlib.Path(__file__).resolve().parents[3]/'apps/web/public')
WORD=open(f'{PUB}/brand/bullizard-logo-light.svg').read()
MARK=open(f'{PUB}/brand/bullizard-mark-light.svg').read()
ICON=open(f'{PUB}/brand/bullizard-app-icon.svg').read()
HERO='data:image/jpeg;base64,'+base64.b64encode(open(f'{PUB}/img/hero.jpg','rb').read()).decode()
FONT='<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Alexandria:wght@500;700;800&family=Inter:wght@400;500;600;700&display=block">'
NIGHT='#0d131c'; PAPER='#16202e'; FROST='#eef1f5'; STEEL='#9aa8bb'; RUNE='#77bd77'

GAMES=[ # slug, name, tint, motif
 ('aion','Aion','#4f8cff','arcs'),
 ('aion-2','Aion 2','#8b6cff','arcs2'),
 ('albion-online','Albion Online','#d99a1e','contours'),
 ('path-of-exile','Path of Exile','#d0503a','orbs'),
 ('path-of-exile-2','Path of Exile 2','#2fb3a8','lattice'),
]

def pattern(motif, w, h, tint, seed=7):
    r=random.Random(seed); out=[]
    if motif=='contours':
        cx,cy=w*0.72,h*0.55
        for k in range(16):
            R=40+k*26; pts=[]
            ph=[r.uniform(0,6.28) for _ in range(3)]
            for i in range(97):
                a=i/96*2*math.pi
                rr=R*(1+0.10*math.sin(3*a+ph[0])+0.06*math.sin(5*a+ph[1])+0.04*math.sin(2*a+ph[2]))
                pts.append(f'{cx+rr*math.cos(a)*1.5:.1f},{cy+rr*math.sin(a):.1f}')
            op=0.55-k*0.028
            out.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{tint}" stroke-width="1.6" opacity="{max(op,0.08):.2f}"/>')
    elif motif in ('arcs','arcs2'):
        base=[(w*0.62,h*1.15)] if motif=='arcs' else [(w*0.55,h*1.2),(w*0.98,h*1.2)]
        for bx,by in base:
            for k in range(22):
                R=h*0.35+k*h*0.055
                a0=math.radians(-160+k*1.5); a1=math.radians(-20-k*1.2)
                x0,y0=bx+R*math.cos(a0),by+R*math.sin(a0); x1,y1=bx+R*math.cos(a1),by+R*math.sin(a1)
                op=0.6-k*0.024
                out.append(f'<path d="M{x0:.1f} {y0:.1f} A{R:.1f} {R:.1f} 0 0 1 {x1:.1f} {y1:.1f}" fill="none" stroke="{tint}" stroke-width="{2.2-k*0.06:.2f}" opacity="{max(op,0.08):.2f}" stroke-linecap="round"/>')
    elif motif=='orbs':
        for i in range(70):
            x=r.uniform(w*0.42,w*1.02); y=r.uniform(-20,h+20); rad=r.choice([6,8,10,14,18,26,34])
            d=(x-w*0.42)/(w*0.6); op=0.15+0.5*d
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rad}" fill="none" stroke="{tint}" stroke-width="{1.4 if rad<20 else 2}" opacity="{op:.2f}"/>')
            if r.random()<0.35: out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rad*0.35:.1f}" fill="{tint}" opacity="{op*0.8:.2f}"/>')
    elif motif=='lattice':
        s=46
        for row in range(-1,int(h/(s*0.866))+2):
            for col in range(-1,int(w/s)+2):
                x=col*s+(s/2 if row%2 else 0); y=row*s*0.866
                if x<w*0.38: continue
                d=(x-w*0.38)/(w*0.62); op=0.08+0.5*d*(0.6+0.4*math.sin(row*0.7+col*0.4))
                pts=' '.join(f'{x+16*math.cos(math.radians(60*k+30)):.1f},{y+16*math.sin(math.radians(60*k+30)):.1f}' for k in range(6))
                out.append(f'<polygon points="{pts}" fill="none" stroke="{tint}" stroke-width="1.4" opacity="{max(op,0.05):.2f}"/>')
    return f'<svg class="pat" viewBox="0 0 {w} {h}" width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">{"".join(out)}</svg>'

BASE_CSS=f"""*{{margin:0;padding:0;box-sizing:border-box}} body{{background:{NIGHT};}}
.c{{position:relative;overflow:hidden;background:radial-gradient(120% 140% at 85% 30%, var(--glow) 0%, transparent 55%), linear-gradient(135deg,{NIGHT} 0%,{PAPER} 100%);color:{FROST};font-family:Inter,sans-serif}}
.pat{{position:absolute;inset:0}} div > .pat{{position:static;display:block}} .shade{{position:absolute;inset:0;background:linear-gradient(90deg,{NIGHT} 0%, rgba(13,19,28,.85) 30%, rgba(13,19,28,0) 65%)}}
h1,.d{{font-family:Alexandria,sans-serif;font-weight:800;letter-spacing:-0.01em;line-height:1.02;text-wrap:balance}} p{{text-wrap:balance}}
.mark svg{{display:block;width:100%;height:auto}} .word svg{{display:block;width:100%;height:auto}}
"""
def page(w,h,body,extra=''):
    return f'<!doctype html><html><head><meta charset="utf-8">{FONT}<style>{BASE_CSS} html,body{{width:{w}px;height:{h}px}} {extra}</style></head><body>{body}</body></html>'

def hexa(c,a): 
    c=c.lstrip('#'); return f'rgba({int(c[0:2],16)},{int(c[2:4],16)},{int(c[4:6],16)},{a})'

files={}
# ---- Game banners 1200x400 and tiles 512x512
for slug,name,tint,motif in GAMES:
    w,h=1200,400
    body=f'''<div class="c" style="width:{w}px;height:{h}px;--glow:{hexa(tint,.28)}">{pattern(motif,w,h,tint)}<div class="shade"></div>
<div style="position:absolute;left:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:22px">
<span style="display:block;width:56px;height:5px;border-radius:3px;background:{tint}"></span>
<h1 style="font-size:{84 if len(name)<12 else 76}px">{name}</h1></div>
<div class="mark" style="position:absolute;right:56px;bottom:44px;width:44px;opacity:.55">{MARK}</div></div>'''
    files[f'games/{slug}-banner']=(page(w,h,body),w,h,2)
    # Art only (the app writes the game name over it): /games/<slug>.webp
    plain=f'''<div class="c" style="width:{w}px;height:{h}px;--glow:{hexa(tint,.30)}">{pattern(motif,w,h,tint)}<div style="position:absolute;inset:0;background:linear-gradient(90deg,{NIGHT} 0%, rgba(13,19,28,.7) 28%, rgba(13,19,28,0) 60%)"></div></div>'''
    files[f'app/{slug}']=(page(w,h,plain),w,h,1)
    w=h=512
    body=f'''<div class="c" style="width:{w}px;height:{h}px;--glow:{hexa(tint,.30)}"><div style="position:absolute;top:0;left:-{int(w*0.75)}px">{pattern(motif,int(w*1.75),h,tint)}</div><div style="position:absolute;inset:0;background:linear-gradient(0deg,{NIGHT} 5%, rgba(13,19,28,.4) 55%, rgba(13,19,28,0) 100%)"></div>
<div style="position:absolute;left:44px;right:44px;bottom:48px;display:flex;flex-direction:column;gap:18px">
<span style="display:block;width:48px;height:5px;border-radius:3px;background:{tint}"></span>
<h1 style="font-size:{64 if len(name)<12 else 56}px">{name}</h1></div>
<div class="mark" style="position:absolute;right:40px;top:40px;width:40px;opacity:.55">{MARK}</div></div>'''
    files[f'games/{slug}-tile']=(page(w,h,body),w,h,1)

# ---- Social: icons
for key,size,inner in [('social/discord-icon',512,0.86),('social/telegram-avatar',640,0.72)]:
    s=size; ic=int(s*inner)
    body=f'''<div style="width:{s}px;height:{s}px;background:#4bae24;display:grid;place-items:center"><div class="mark" style="width:{int(ic*0.62)}px">{MARK.replace('#eef1f5',NIGHT)}</div></div>'''
    files[key]=(page(s,s,body),s,s,1)

# strip of 5 game colours used as a motif in social banners
def strip(w,h):
    n=len(GAMES)
    glows=', '.join(f'radial-gradient(28% 55% at {(i+0.5)*100/n:.0f}% {30 if i%2 else 75}%, {hexa(t,.32)} 0%, transparent 70%)' for i,(s_,n_,t,m) in enumerate(GAMES))
    return f'<div style="position:absolute;inset:0;background:{glows}, {NIGHT}"></div><div style="position:absolute;inset:0;opacity:.55">{pattern("contours",w,h,"#9aa8bb",seed=11).replace("class=\"pat\"","class=\"pat\" preserveAspectRatio=\"xMidYMid slice\"")}</div>'

def lockup(width):
    mw=width*0.2
    return f'<div style="display:flex;align-items:center;gap:{width*0.08:.0f}px"><div class="mark" style="width:{mw:.0f}px">{MARK}</div><div class="word" style="width:{width:.0f}px">{WORD}</div></div>'

GAMELIST='Aion · Aion 2 · Albion Online · Path of Exile 1 &amp; 2'
TXT={  # Copywriter's final lines (claude/bullizard-copy-deck.md §1 and §7.1)
 'en':dict(dir='ltr',head='The grind is optional now.',sub='Buy gold, items and top-ups from players who already farmed them. Every order human-checked.',community='Skip the grind. Every order human-checked.',launch='Opens today',games=GAMELIST),
 'ar':dict(dir='rtl',head='الفارم صار اختياريًا.',sub='اشترِ الذهب والآيتمز والشحن من لاعبين فرموها قبلك. وكل طلب يراجعه إنسان.',community='تخطَّ الفارم. وكل طلب يراجعه إنسان.',launch='يفتح اليوم',games=GAMELIST),
}
# Discord banner 960x540, invite splash 1920x1080, Telegram header 1280x720 (bilingual)
for key,w,h in [('social/discord-banner',960,540),('social/discord-invite-splash',1920,1080),('social/telegram-header',1280,720)]:
    k=w/960
    body=f'''<div style="position:relative;width:{w}px;height:{h}px;background:{NIGHT};overflow:hidden">{strip(w,h)}
<div style="position:absolute;inset:0;background:radial-gradient(70% 70% at 50% 50%, rgba(13,19,28,.94) 0%, rgba(13,19,28,.8) 55%, rgba(13,19,28,.35) 100%)"></div>
<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:{26*k:.0f}px;text-align:center;color:{FROST}">
{lockup(340*k)}
<p style="font:600 {24*k:.0f}px/1.4 Inter;color:{FROST}">{TXT['en']['community']}</p>
<p dir="rtl" style="font:600 {25*k:.0f}px/1.4 Alexandria;color:{FROST}">{TXT['ar']['community']}</p>
<p style="font:500 {16*k:.0f}px/1.4 Inter;color:{STEEL}">News, new games and offers · No trading here</p></div></div>'''
    files[key]=(page(w,h,body),w,h,1)

# Launch posts: square, portrait, story, landscape; EN + AR
for lang,T in TXT.items():
    rtl=T['dir']=='rtl'; ff='Alexandria' if rtl else 'Inter'
    for key,w,h in [('square',1080,1080),('portrait',1080,1350),('story',1080,1920),('landscape',1200,675)]:
        land=w>h; k=w/1080 if not land else 0.8
        chips=''.join(f'<span style="display:inline-flex;align-items:center;gap:{10*k:.0f}px;padding:{10*k:.0f}px {18*k:.0f}px;border:1.5px solid rgba(238,241,245,.22);border-radius:999px;font:600 {22*k:.0f}px Inter;color:{FROST};background:rgba(13,19,28,.55)"><i style="width:{10*k:.0f}px;height:{10*k:.0f}px;border-radius:50%;background:{t}"></i>{n}</span>' for s,n,t,m in GAMES)
        photo_h = h*0.48 if not land else h
        photo=f'''<div style="position:absolute;{'right:0;top:0;bottom:0;width:58%' if land else f'left:0;right:0;top:0;height:{photo_h:.0f}px'};background:url({HERO}) right top/cover no-repeat;{'transform:scaleX(-1)' if rtl and not land else ''}"></div>
<div style="position:absolute;inset:0;background:{f'linear-gradient(90deg,{NIGHT} 40%, rgba(13,19,28,.7) 60%, rgba(13,19,28,0) 85%)' if land and not rtl else (f'linear-gradient(270deg,{NIGHT} 40%, rgba(13,19,28,.7) 60%, rgba(13,19,28,0) 85%)' if land else f'linear-gradient(0deg,{NIGHT} 52%, rgba(13,19,28,.6) 66%, rgba(13,19,28,0) 85%)')}"></div>'''
        if land and rtl: photo=photo.replace('right:0;top:0;bottom:0;width:58%','left:0;top:0;bottom:0;width:58%')
        pad=64*k
        textbox_w = w*0.56 if land else w-2*pad
        body=f'''<div dir="{T['dir']}" style="position:relative;width:{w}px;height:{h}px;background:{NIGHT};overflow:hidden;color:{FROST}">{photo}
<div style="position:absolute;top:{pad:.0f}px;{'right' if rtl else 'left'}:{pad:.0f}px">{lockup(230*k) if not rtl else f'<div style="display:flex;align-items:center;gap:{14*k:.0f}px"><div class="mark" style="width:{50*k:.0f}px">{MARK}</div><span style="font:800 {48*k:.0f}px/1 Alexandria">بوليزارد</span></div>'}</div>
<div style="position:absolute;{'right' if rtl else 'left'}:{pad:.0f}px;bottom:{pad:.0f}px;width:{textbox_w:.0f}px;display:flex;flex-direction:column;gap:{24*k:.0f}px">
<span style="align-self:flex-start;padding:{8*k:.0f}px {16*k:.0f}px;border-radius:999px;background:#4bae24;color:{NIGHT};font:700 {22*k:.0f}px {ff}">{T['launch']}</span>
<h1 class="d" style="font-size:{(86 if not rtl else 92)*k*(0.85 if key=='square' else 1.2 if key=='story' else 1):.0f}px;font-family:Alexandria">{T['head']}</h1>
<p style="font:500 {28*k:.0f}px/1.45 {ff};color:#c9d2de;max-width:{(textbox_w):.0f}px">{T['sub']}</p>
<div dir="ltr" style="display:flex;flex-wrap:wrap;gap:{10*k:.0f}px;{'justify-content:flex-end' if rtl else ''}">{chips}</div></div></div>'''
        files[f'launch/launch-{key}-{lang}']=(page(w,h,body),w,h,1)

os.makedirs('html',exist_ok=True)
manifest=[]
for name,(html,w,h,scale) in files.items():
    p=f'html/{name}.html'; os.makedirs(os.path.dirname(p),exist_ok=True); open(p,'w').write(html)
    manifest.append(dict(name=name,w=w,h=h,scale=scale))
json.dump(manifest,open('manifest.json','w'))
print(len(manifest))
