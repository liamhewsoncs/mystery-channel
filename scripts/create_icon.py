from pathlib import Path
from PIL import Image, ImageDraw


root = Path(__file__).resolve().parents[1]
build = root / "build"
build.mkdir(exist_ok=True)
size = 256
image = Image.new("RGBA", (size, size), (9, 10, 15, 255))
pixels = image.load()

for y in range(size):
    for x in range(size):
        distance = ((x - 128) ** 2 + (y - 128) ** 2) ** 0.5
        glow = max(0.0, 1.0 - distance / 170)
        pixels[x, y] = (
            int(10 + 53 * glow),
            int(11 + 36 * glow),
            int(16 + 19 * glow),
            255,
        )

draw = ImageDraw.Draw(image)
draw.rounded_rectangle((34, 34, 222, 222), radius=50, fill=(19, 20, 26, 255), outline=(235, 184, 107, 120), width=4)
for inset, alpha in ((34, 45), (51, 70), (68, 95)):
    draw.ellipse((inset, inset, size - inset, size - inset), outline=(235, 184, 107, alpha), width=3)
draw.ellipse((81, 81, 175, 175), fill=(210, 148, 69, 255), outline=(245, 201, 128, 255), width=3)
draw.polygon(((116, 101), (116, 155), (158, 128)), fill=(19, 20, 26, 255))

image.save(build / "icon.png")
image.save(build / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
