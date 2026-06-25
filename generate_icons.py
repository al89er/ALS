import sys
import subprocess

def install_pillow():
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow"])

try:
    from PIL import Image, ImageDraw
except ImportError:
    install_pillow()
    from PIL import Image, ImageDraw

def create_icon(size, filename):
    img = Image.new('RGB', (size, size), color='#0b0f19')
    d = ImageDraw.Draw(img)
    # Draw a blue triangle in the center
    cx, cy = size // 2, size // 2
    h = size // 3
    w = size // 3
    points = [
        (cx, cy - h),
        (cx - w, cy + h),
        (cx + w, cy + h)
    ]
    d.polygon(points, fill='#3b82f6')
    img.save(filename)

create_icon(192, 'icon-192.png')
create_icon(512, 'icon-512.png')
create_icon(256, 'icon.png')
print("Icons created.")
