#!/usr/bin/env python3
"""Her logo, everywhere it is needed, from the two masters in branding/.

    python3 scripts/make-icons.py

  branding/yui-head.png   the backgroundless head — every icon: the app (icon.png, yui.ico), the
                          extension (extension/icons/icon{16,32,48,128}.png), the website
                          (copied by build-web.js to assets/icon.png and favicon.ico)
  branding/yui-pfp.png    the square portrait with its background — social previews
                          (copied by build-web.js to assets/yui-pfp.png for og:image)

The head is cropped to its visible pixels and padded a little, so it fills an icon instead of
floating in transparent margins. Needs Pillow (python3 -m pip install pillow).
"""
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEAD = os.path.join(ROOT, 'branding', 'yui-head.png')
PFP = os.path.join(ROOT, 'branding', 'yui-pfp.png')

def square_head(pad=0.04):
    im = Image.open(HEAD).convert('RGBA')
    box = im.getchannel('A').getbbox()
    if not box:
        sys.exit('branding/yui-head.png is fully transparent')
    im = im.crop(box)
    side = int(max(im.size) * (1 + 2 * pad))
    out = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    out.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    return out

def resized(src, n):
    return src.resize((n, n), Image.LANCZOS)

def main():
    head = square_head()
    # the app: the tray icon (main.js resizes it to 16) and the exe / favicon .ico
    resized(head, 256).save(os.path.join(ROOT, 'icon.png'))
    resized(head, 256).save(os.path.join(ROOT, 'yui.ico'), sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
    # the extension: manifest icons, action icon, the popup's header
    icons = os.path.join(ROOT, 'extension', 'icons')
    os.makedirs(icons, exist_ok=True)
    for n in (16, 32, 48, 128):
        resized(head, n).save(os.path.join(icons, 'icon%d.png' % n))
    # sanity: the portrait must be square, or the social card is cropped by whoever renders it
    pfp = Image.open(PFP)
    if pfp.width != pfp.height:
        sys.exit('branding/yui-pfp.png must be square (is %dx%d)' % pfp.size)
    print('[icons] icon.png, yui.ico, extension/icons/icon{16,32,48,128}.png written from branding/yui-head.png')

if __name__ == '__main__':
    main()
