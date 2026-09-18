#!/usr/bin/env python3
"""Harvest a presenter's brand from their site (+ public IG header) before writing copy.
Usage: harvest_brand.py <out_dir> <url> [url ...] [--ig handle]
Produces in <out_dir>: raw/ (full-size images), sheet.jpg (contact sheet, numbered), facts.json
(page text snippets around credential keywords, IG followers), palette.json (dominant colours of photos and logos).
Every fetch verifies TLS (via certifi's CA bundle when installed, else the interpreter's own trust store)
and times out after 30 seconds: facts.json is the source of truth for every claim on the page, so an
unverified certificate would let anything author it. If every source URL fails to fetch, the script exits
with status 2 and a stderr line instead of writing an empty sheet.
Limits: a single image is skipped above 15 MB, and at most 400 images are saved (the run record caps the count too).
Wix: strips /v1/fill|crop transforms to get originals. WordPress: strips -WxH suffixes."""
import sys, re, os, json, html, ssl, urllib.request, hashlib
from collections import Counter
from PIL import Image, ImageDraw

try:
    import certifi
except ImportError:
    certifi = None

MAX_IMAGE_BYTES=15*1024*1024  # one download; a page image is never this big, a tarball is
MAX_IMAGES=400                # the run record refuses a larger count, so the script never produces one
UA={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
# Credential keywords, deliberately generic: they must fit any presenter, not
# the one whose site was harvested last. A place name or a niche term here
# quietly biases facts.json toward one tenant's story.
KW=['אוניברסיטה','מכללה','מכון','הסמכה','בוגרת','בוגר','מרצה','שנים','עוקבים','לקוחות','התארח','ynet','כאן','רדיו','תעודה','Certified','Institute','Association','years','followers']


def ssl_context():
    """TLS context for every fetch. Verification is always on: facts.json is the
    source of truth for every claim, so an unverified certificate would let
    anything author it. Some interpreters (notably python.org's macOS build)
    ship with no CA bundle at all, so we point at certifi's when it is
    installed; otherwise we fall back to the interpreter's own default store."""
    if certifi is not None:
        return ssl.create_default_context(cafile=certifi.where())
    return ssl.create_default_context()


def summarize_outcome(fetched_count, first_error):
    """(exit_code, stderr_message) for the run as a whole. Zero successful page
    fetches means nothing in facts.json can be trusted, so that is a hard
    failure (exit 2) rather than an empty sheet quietly reaching the gate.
    A partial success (some URLs fetched) is still exit 0."""
    if fetched_count == 0:
        detail = first_error if first_error else 'no error recorded'
        return 2, f'harvest: no source could be fetched: {detail}'
    return 0, None


def parse_args(argv):
    """<out_dir> <url> [url ...] [--ig handle] -> (out_dir, urls, ig_handle).

    A scheme is case-insensitive (HTTPS://Example.com is a URL like
    https://example.com is), so the filter lowercases before the prefix check.
    """
    out = argv[0]
    urls = [a for a in argv[1:] if a.lower().startswith('http')]
    ig = argv[argv.index('--ig') + 1] if '--ig' in argv else None
    return out, urls, ig


def get(u,binary=False,limit=None):
    r=urllib.request.Request(u,headers=UA)
    with urllib.request.urlopen(r,timeout=30,context=ssl_context()) as resp:
        d=resp.read() if limit is None else resp.read(limit+1)
    if limit is not None and len(d)>limit: raise ValueError(f'larger than {limit} bytes')
    return d if binary else d.decode('utf-8','ignore')


def main(argv):
    out, urls, ig = parse_args(argv)
    os.makedirs(f'{out}/raw',exist_ok=True)
    facts={'sources':urls,'snippets':[]}; imgs=set()
    fetched_count=0; first_error=None
    for u in urls:
        try: s=get(u)
        except Exception as e:
            print('skip',u,e)
            if first_error is None: first_error=f'{u}: {e}'
            continue
        fetched_count+=1
        t=re.sub(r'<script.*?</script>|<style.*?</style>','',s,flags=re.S); t=html.unescape(re.sub(r'<[^>]+>',' ',t)); t=re.sub(r'\s+',' ',t)
        for kw in KW:
            for m in list(re.finditer(re.escape(kw),t))[:3]:
                facts['snippets'].append({'kw':kw,'text':t[max(0,m.start()-160):m.end()+160],'url':u})
        for m in re.findall(r'https?://[^"\'\s)]+?\.(?:jpg|jpeg|png|webp)(?:[^"\'\s)]*)',s,flags=re.I):
            m=html.unescape(m)
            if 'wixstatic.com/media/' in m: m=re.sub(r'(~mv2\.\w+).*$',r'\1',m)
            m=re.sub(r'-\d{2,4}x\d{2,4}(\.\w+)$',r'\1',m)
            imgs.add(m)
    exit_code, exit_message = summarize_outcome(fetched_count, first_error)
    if exit_code != 0:
        print(exit_message, file=sys.stderr)
        return exit_code
    if ig:
        try:
            s=''
            for _ in range(3):
                s=get(f'https://www.instagram.com/{ig}/')
                if 'og:description' in s: break
            d=re.search(r'og:description" content="([^"]*)',s); facts['instagram']=html.unescape(d.group(1)) if d else None
            p=re.search(r'og:image" content="([^"]*)',s)
            if p: imgs.add(html.unescape(p.group(1)).replace('s100x100','s1080x1080'))
            facts['instagram_note']='Posts need a logged-in session: use the browse skill (Chrome) to scroll the grid and save the top posts.'
        except Exception as e: facts['instagram_error']=str(e)
    saved=[]
    for i,u in enumerate(sorted(imgs)):
        if len(saved)>=MAX_IMAGES: print('image cap reached:',MAX_IMAGES); break
        try:
            d=get(u,True,MAX_IMAGE_BYTES)
            if len(d)<8000: continue
            ext=re.search(r'\.(jpe?g|png|webp)',u.lower()); ext=ext.group(1) if ext else 'jpg'
            fn=f'{out}/raw/img_{len(saved)+1:02d}.{ext}'; open(fn,'wb').write(d)
            im=Image.open(fn);
            if min(im.size)<120: os.remove(fn); continue
            saved.append((fn,u))
        except Exception as e: print('skip image',u,e)
    # contact sheet
    thumbs=[]
    for fn,u in saved:
        im=Image.open(fn).convert('RGB'); im.thumbnail((260,260)); c=Image.new('RGB',(260,280),'white'); c.paste(im,((260-im.width)//2,0)); ImageDraw.Draw(c).text((4,264),os.path.basename(fn),fill='black'); thumbs.append(c)
    cols=6; rows=max(1,(len(thumbs)+cols-1)//cols); sheet=Image.new('RGB',(cols*260,rows*280),'white')
    for i,t in enumerate(thumbs): sheet.paste(t,((i%cols)*260,(i//cols)*280))
    sheet.save(f'{out}/sheet.jpg',quality=80)
    # palette: dominant non-neutral colours across photos
    cnt=Counter()
    for fn,u in saved:
        im=Image.open(fn).convert('RGB').resize((40,40))
        for r,g,b in im.getdata():
            if max(r,g,b)-min(r,g,b)<28: continue  # skip greys
            cnt[(r//16*16,g//16*16,b//16*16)]+=1
    pal=['#%02x%02x%02x'%c for c,_ in cnt.most_common(8)]
    json.dump({'dominant_saturated':pal,'note':'Check against the site CSS and the logo; neutrals (black/white) are decided by the portrait backgrounds.'},open(f'{out}/palette.json','w'),ensure_ascii=False,indent=1)
    json.dump({'images':[{'file':os.path.basename(f),'url':u} for f,u in saved],**facts},open(f'{out}/facts.json','w'),ensure_ascii=False,indent=1)
    print(f'{len(saved)} images -> {out}/raw, sheet.jpg, palette {pal[:5]}, IG: {(facts.get("instagram") or "-")[:60]}')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
