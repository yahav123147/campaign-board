#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compose.py — קומפוזיטור קראייטיבים (4:5, 2160x2700)
שימוש: python3 compose.py spec.json [spec2.json ...]

תלויות: Pillow, python-bidi (שתיהן מותקנות אצל המשתמש).
הפונט Heebo (variable weight) מגיע עם הסקיל ב-assets/Heebo.ttf.

===================== פורמט ה-SPEC =====================
{
  "out": "/path/to/output.png",

  // --- מצב 1: תמונה אמיתית מלאה כרקע ---
  "scene": {"image": "/path.png", "fx": 0.5, "fy": 0.25},
  // fx/fy = מיקוד הקרופ (0=שמאל/למעלה, 1=ימין/למטה)
  // אפשר "crop": [x0,y0,x1,y1] לחיתוך מקדים (למשל להוציא אדם מהפריים)

  // --- מצב 2: cutout שקוף על רקע ---
  "cutout": {
    "image": "/path-rgba.png",
    "target_h": 760,          // גובה הדמות ביחידות 1080x1350
    "center_x": 560, "top_y": 110,
    "warm": 0.20,             // דירוג חם 0-0.3 להשתלבות ברקע
    "bg": {"type": "image", "image": "/stage.png"}   // או:
    //    {"type": "gradient"}  רקע כהה מינימלי + זוהר אמבר
  },

  "top_scrim":    {"end": 330},                       // אופציונלי, לטקסט עליון
  "bottom_scrim": {"start": 600, "mid": 880},         // כמעט תמיד צריך

  "lines": [
    {"cy": 795, "text": "אתה לא צריך עוד קורס.", "size": 88, "weight": 900, "color": "white"},
    {"cy": 892, "text": "אתה צריך מערכת שעובדת בשבילך.", "size": 60, "weight": 800, "color": "gold"},
    {"cy": 990, "text": "שורת אמפתיה.", "size": 42, "weight": 500, "color": "soft"},
    // שורה דו-צבעית (ימין לבן, שמאל זהב):
    {"cy": 943, "two_tone": {"right": "התקדמת קצת,", "left": "ונשארת לבד."},
     "size": 54, "weight": 700, "right_color": "white", "left_color": "gold"}
  ],

  "bar":   {"text": "מצטרפים להמותג ‹", "by": 1140, "bw": 720},  // פס CTA זהב
  "brand": {"cy": 1290, "text": "המותג"}                          // שורת מותג, אופציונלי
}

כל הקואורדינטות במערכת 1080x1350 — הסקריפט מרנדר פי 2 (2160x2700) אוטומטית.
בדיקת עומק אחרי רינדור: לקרוא את הקובץ ולוודא שהטקסט לא יושב על הפנים.
"""
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageChops
from bidi.algorithm import get_display

S = 2
W, H = 1080 * S, 1350 * S

COLORS = {
    "white": (250, 250, 250),
    "gold": (222, 178, 88),
    "gold_hot": (240, 196, 105),
    "soft": (225, 222, 218),
    "ink": (24, 18, 8),
}

FONT_PATH = str(Path(__file__).resolve().parent.parent / "assets" / "fonts" / "Heebo.ttf")


def resolve_color(value, fallback="white"):
    """Named palette color, or a #RRGGBB hex from the plan."""
    if isinstance(value, str) and value.startswith("#") and len(value) == 7:
        try:
            return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            pass
    return COLORS.get(value, COLORS[fallback])


def font(size, weight):
    f = ImageFont.truetype(FONT_PATH, size * S)
    f.set_variation_by_axes([weight])
    f._weight = weight
    return f


SAFE_TEXT_RE = re.compile(
    r"[^\u0590-\u05FF\u0020-\u007E\u2039\u203A\u00AB\u00BB\u20AA\u2013\u2014\u201C\u201D\u2018\u2019]"
)


def rtl(s):
    # Heebo carries Hebrew + Latin; anything else renders as tofu. Strip it.
    s = SAFE_TEXT_RE.sub("", str(s)).strip()
    return get_display(s)


def text_box(draw, t, fnt):
    bb = draw.textbbox((0, 0), t, font=fnt)
    return bb[2] - bb[0], bb


MAX_TEXT_W = 1000 * S  # שוליים בטוחים: שורה לעולם לא נחתכת בקצוות


def fit_font(draw, text, fnt):
    """מכווץ את הפונט עד שהשורה נכנסת בשוליים הבטוחים."""
    w, _ = text_box(draw, text, fnt)
    size = getattr(fnt, "size", None)
    while w > MAX_TEXT_W and size and size > 8 * S:
        size -= 2 * S
        weight = getattr(fnt, "_weight", 700)
        fnt = ImageFont.truetype(FONT_PATH, size)
        try:
            fnt.set_variation_by_axes([weight])
            fnt._weight = weight
        except Exception:
            pass
        w, _ = text_box(draw, text, fnt)
    return fnt


def soft_text(img, cy, text, fnt, fill, cx=None):
    """טקסט חד עם צל רך מטושטש — הסטנדרט של הסגנון."""
    t = rtl(text)
    d0 = ImageDraw.Draw(img)
    fnt = fit_font(d0, t, fnt)
    w, bb = text_box(d0, t, fnt)
    h = bb[3] - bb[1]
    x = ((W - w) // 2 if cx is None else int(cx * S) - w // 2) - bb[0]
    y = int(cy * S) - h // 2 - bb[1]
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((x + 3 * S, y + 4 * S), t, font=fnt, fill=(0, 0, 0, 200))
    sh = sh.filter(ImageFilter.GaussianBlur(6 * S))
    img.paste(Image.new("RGB", img.size, (0, 0, 0)), (0, 0), sh)
    ImageDraw.Draw(img).text((x, y), t, font=fnt, fill=fill)


def soft_two_tone(img, cy, right_txt, left_txt, fnt, right_fill, left_fill, gap=14):
    """שורה RTL בשני צבעים: הסגמנט הימני מצויר מימין, השמאלי משמאלו."""
    d0 = ImageDraw.Draw(img)
    tr, tl = rtl(right_txt), rtl(left_txt)
    wr, bbr = text_box(d0, tr, fnt)
    wl, bbl = text_box(d0, tl, fnt)
    total = wr + gap * S + wl
    x0 = (W - total) // 2
    yr = int(cy * S) - (bbr[3] - bbr[1]) // 2 - bbr[1]
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dsh = ImageDraw.Draw(sh)
    dsh.text((x0 + 3 * S, yr + 4 * S), tl, font=fnt, fill=(0, 0, 0, 200))
    dsh.text((x0 + wl + gap * S + 3 * S, yr + 4 * S), tr, font=fnt, fill=(0, 0, 0, 200))
    sh = sh.filter(ImageFilter.GaussianBlur(6 * S))
    img.paste(Image.new("RGB", img.size, (0, 0, 0)), (0, 0), sh)
    d = ImageDraw.Draw(img)
    d.text((x0, yr), tl, font=fnt, fill=left_fill)
    d.text((x0 + wl + gap * S, yr), tr, font=fnt, fill=right_fill)


def cover(img, fx=0.5, fy=0.5):
    s = max(W / img.width, H / img.height)
    img = img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
    x = int((img.width - W) * fx)
    y = int((img.height - H) * fy)
    return img.crop((x, y, x + W, y + H))


def bottom_scrim(img, start=600, mid=880, amax=245):
    black = Image.new("RGB", (W, H), (8, 6, 4))
    m = Image.new("L", (1, H), 0)
    for y in range(H):
        yy = y / S
        if yy < start:
            a = 0
        elif yy < mid:
            a = int(210 * (yy - start) / (mid - start))
        else:
            a = 210 + int(35 * min(1, (yy - mid) / 300))
        m.putpixel((0, y), min(a, amax))
    return Image.composite(black, img, m.resize((W, H)))


def top_scrim(img, end=330, amax=215):
    black = Image.new("RGB", (W, H), (8, 6, 4))
    m = Image.new("L", (1, H), 0)
    for y in range(H):
        yy = y / S
        a = int(amax * (1 - yy / end)) if yy < end else 0
        m.putpixel((0, y), max(a, 0))
    return Image.composite(black, img, m.resize((W, H)))


def gold_bar(img, text, by=1150, bw=720, bh=92, fs=46):
    bw, bh, by = bw * S, bh * S, by * S
    bx = (W - bw) // 2
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([bx, by + 6 * S, bx + bw, by + bh + 6 * S],
                                         radius=bh // 4, fill=(0, 0, 0, 140))
    sh = sh.filter(ImageFilter.GaussianBlur(10 * S))
    img.paste(Image.new("RGB", img.size, (0, 0, 0)), (0, 0), sh)
    grad = Image.new("RGB", (bw, bh))
    g0, g1 = (183, 138, 55), (246, 214, 130)
    gd = ImageDraw.Draw(grad)
    for x in range(bw):
        tt = 1 - abs(0.5 - x / bw) * 2
        c = tuple(int(g0[i] + (g1[i] - g0[i]) * tt) for i in range(3))
        gd.line([(x, 0), (x, bh)], fill=c)
    bm = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(bm).rounded_rectangle([0, 0, bw, bh], radius=18 * S, fill=255)
    img.paste(grad, (bx, by), bm)
    f = font(fs, 800)
    d = ImageDraw.Draw(img)
    t = rtl(text)
    wt, bb = text_box(d, t, f)
    while wt > bw - 40 * S and fs > 18:
        fs -= 2
        f = font(fs, 800)
        wt, bb = text_box(d, t, f)
    d.text((bx + (bw - wt) // 2 - bb[0], by + (bh - (bb[3] - bb[1])) // 2 - bb[1]),
           t, font=f, fill=COLORS["ink"])


def prep_cutout(path, target_h, warm=0.20):
    cut = Image.open(path)
    cut = cut.crop(cut.getbbox())
    th = int(target_h * S)
    sc = th / cut.height
    cut = cut.resize((int(cut.width * sc), th), Image.LANCZOS)
    r, g, b, a = cut.split()
    rgb = Image.merge("RGB", (r, g, b))
    if warm:
        rgb = Image.blend(rgb, ImageChops.multiply(rgb, Image.new("RGB", rgb.size, (255, 178, 92))), warm)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.04)
    fade = Image.new("L", (1, th), 255)
    fh = int(th * 0.21)
    for y in range(th):
        if y > th - fh:
            fade.putpixel((0, y), int(255 * max(0, (th - y) / fh)))
    a = ImageChops.multiply(a, fade.resize(cut.size))
    return Image.merge("RGBA", (*rgb.split(), a))


def gradient_bg(glow_center=(540, 330), glow_color=(105, 68, 22)):
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(26 - 12 * t), int(22 - 10 * t), int(18 - 9 * t)))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gx, gy = glow_center
    ImageDraw.Draw(glow).ellipse([(gx - 380) * S, (gy - 380) * S, (gx + 380) * S, (gy + 380) * S],
                                 fill=glow_color)
    glow = glow.filter(ImageFilter.GaussianBlur(180 * S))
    return ImageChops.screen(img, glow)


def build(spec):
    # --- base ---
    if "scene" in spec:
        sc = spec["scene"]
        img = Image.open(sc["image"]).convert("RGB")
        if "crop" in sc:
            img = img.crop(tuple(sc["crop"]))
        img = cover(img, sc.get("fx", 0.5), sc.get("fy", 0.5))
    elif "cutout" in spec:
        co = spec["cutout"]
        bg = co.get("bg", {"type": "gradient"})
        if bg.get("type") == "image":
            img = cover(Image.open(bg["image"]).convert("RGB"))
            # זוהר חם מאחורי הדמות להשתלבות
            glow = Image.new("RGB", (W, H), (0, 0, 0))
            cx = co.get("center_x", 540)
            ImageDraw.Draw(glow).ellipse([(cx - 330) * S, 50 * S, (cx + 330) * S, 710 * S],
                                         fill=(120, 78, 25))
            glow = glow.filter(ImageFilter.GaussianBlur(160 * S))
            img = ImageChops.screen(img, glow)
        else:
            img = gradient_bg(glow_center=(co.get("center_x", 540), 330))
        cut = prep_cutout(co["image"], co.get("target_h", 760), co.get("warm", 0.20))
        img.paste(cut, (int(co.get("center_x", 540) * S) - cut.width // 2,
                        int(co.get("top_y", 110) * S)), cut)
    else:
        raise SystemExit("spec חייב 'scene' או 'cutout'")

    # --- scrims ---
    if "top_scrim" in spec:
        ts = spec["top_scrim"]
        img = top_scrim(img, ts.get("end", 330), ts.get("amax", 215))
    if "bottom_scrim" in spec:
        bs = spec["bottom_scrim"]
        img = bottom_scrim(img, bs.get("start", 600), bs.get("mid", 880), bs.get("amax", 245))

    # --- text ---
    for ln in spec.get("lines", []):
        fnt = font(ln.get("size", 44), ln.get("weight", 700))
        if "two_tone" in ln:
            tt = ln["two_tone"]
            soft_two_tone(img, ln["cy"], tt["right"], tt["left"], fnt,
                          resolve_color(ln.get("right_color", "white")),
                          resolve_color(ln.get("left_color", "gold"), "gold"))
        else:
            soft_text(img, ln["cy"], ln["text"], fnt, resolve_color(ln.get("color", "white")),
                      cx=ln.get("cx"))

    # --- CTA bar + brand ---
    if "bar" in spec:
        b = spec["bar"]
        gold_bar(img, b["text"], b.get("by", 1150), b.get("bw", 720), b.get("bh", 92), b.get("fs", 46))
    if "brand" in spec:
        br = spec["brand"]
        soft_text(img, br.get("cy", 1290), br.get("text", "המותג"),
                  font(br.get("size", 36), 700), COLORS["gold"])

    out = spec["out"]
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    img.save(out, quality=95)
    print(f"saved {out} ({img.width}x{img.height})")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for spec_path in sys.argv[1:]:
        build(json.loads(Path(spec_path).read_text()))
