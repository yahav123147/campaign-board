#!/usr/bin/env python3
"""Hand-drawn red circle (default) or an underline outside text on a REAL screenshot.
Usage: marker.py in.png out.png x0 y0 x1 y1 [--style circle|underline] [--crop X0 Y0 X1 Y1] [--resize W H]
Legacy --style yellow also underlines: a fill obscures light text on dark screenshots.
Coordinates = the text's bbox in the ORIGINAL image (before crop). Circle is drawn 4x then downsampled (smooth), slightly rotated, double stroke."""
import sys
from PIL import Image, ImageDraw
a=sys.argv; src,dst=a[1],a[2]; x0,y0,x1,y1=map(int,a[3:7])
style=a[a.index('--style')+1] if '--style' in a else 'circle'
crop=tuple(map(int,a[a.index('--crop')+1:a.index('--crop')+5])) if '--crop' in a else None
rs=tuple(map(int,a[a.index('--resize')+1:a.index('--resize')+3])) if '--resize' in a else None
im=Image.open(src).convert('RGBA')
if crop: im=im.crop(crop); x0,x1=x0-crop[0],x1-crop[0]; y0,y1=y0-crop[1],y1-crop[1]
S=4; ov=Image.new('RGBA',(im.width*S,im.height*S),(0,0,0,0)); d=ImageDraw.Draw(ov)
if style in ('underline', 'yellow'):
    # Keep the text rectangle untouched. No room below it means no mark,
    # rather than drawing over the last line or inventing screenshot content.
    top = y1 + 3
    if top + 3 < im.height:
        d.line((x0*S, top*S, x1*S, top*S), fill=(224,176,0,255), width=3*S)
    else:
        print('No room below the text; screenshot left unmarked.')
else:
    px,py=int((x1-x0)*.1)+8,int((y1-y0)*.35)+6
    box=((x0-px)*S,(y0-py)*S,(x1+px)*S,(y1+py)*S)
    d.ellipse(box,outline=(228,36,36,240),width=6*S)
    d.ellipse((box[0]+7*S,box[1]+5*S,box[2]-3*S,box[3]-8*S),outline=(228,36,36,140),width=3*S)
    ov=ov.rotate(-2,resample=Image.BICUBIC,center=((x0+x1)/2*S,(y0+y1)/2*S))
ov=ov.resize(im.size,Image.LANCZOS)
if style in ('underline', 'yellow'):
    # Remove any antialiasing bleed into the text's bounding box.
    ov.paste((0,0,0,0),(x0,y0,x1+1,y1+1))
im=Image.alpha_composite(im,ov)
if rs: im=im.resize(rs,Image.LANCZOS)
save_options = {'lossless': True} if style in ('underline', 'yellow') and dst.lower().endswith('.webp') else {}
im.save(dst, **save_options); print(dst,im.size)
