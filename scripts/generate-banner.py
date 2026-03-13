"""Generate VS Code Marketplace banner for OllamaPilot."""
from PIL import Image, ImageDraw, ImageFont

width, height = 1280, 640
bg_color = (13, 17, 23)
accent = (0, 122, 204)
text_color = (230, 237, 243)
dim_text = (139, 148, 158)

img = Image.new("RGB", (width, height), bg_color)
draw = ImageDraw.Draw(img)

# Top accent line gradient
for x in range(width):
    r = int(accent[0] + (88 - accent[0]) * x / width)
    g = int(accent[1] + (166 - accent[1]) * x / width)
    b = int(accent[2] + (255 - accent[2]) * x / width)
    for y in range(3):
        draw.point((x, y), fill=(r, g, b))

# Load and paste logo
logo = Image.open("images/logo.png").resize((180, 180), Image.LANCZOS)
logo_x = (width - 180) // 2
img.paste(logo, (logo_x, 100))

# Fonts
try:
    title_font = ImageFont.truetype("arial.ttf", 56)
    subtitle_font = ImageFont.truetype("arial.ttf", 24)
    feature_font = ImageFont.truetype("arial.ttf", 20)
except Exception:
    title_font = ImageFont.load_default()
    subtitle_font = title_font
    feature_font = title_font

# Title
title = "OllamaPilot"
bbox = draw.textbbox((0, 0), title, font=title_font)
tw = bbox[2] - bbox[0]
draw.text(((width - tw) // 2, 300), title, fill=text_color, font=title_font)

# Subtitle
subtitle = "Your offline AI coding assistant for VS Code"
bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font)
tw = bbox[2] - bbox[0]
draw.text(((width - tw) // 2, 375), subtitle, fill=dim_text, font=subtitle_font)

# Feature pills
features = ["100% Local", "100% Offline", "100% Free", "Powered by Ollama"]
pill_y = 440
pill_widths = []
for f in features:
    bbox = draw.textbbox((0, 0), f, font=feature_font)
    pill_widths.append(bbox[2] - bbox[0] + 30)
gap = 20
total_width = sum(pill_widths) + gap * (len(features) - 1)
start_x = (width - total_width) // 2

for i, f in enumerate(features):
    pw = pill_widths[i]
    ph = 36
    draw.rounded_rectangle(
        [start_x, pill_y, start_x + pw, pill_y + ph],
        radius=18, fill=(30, 40, 55), outline=accent, width=1
    )
    bbox = draw.textbbox((0, 0), f, font=feature_font)
    tw2 = bbox[2] - bbox[0]
    th2 = bbox[3] - bbox[1]
    draw.text(
        (start_x + (pw - tw2) // 2, pill_y + (ph - th2) // 2 - 2),
        f, fill=accent, font=feature_font
    )
    start_x += pw + gap

# Bottom tagline
tagline = "No cloud  \u00b7  No subscriptions  \u00b7  No telemetry"
bbox = draw.textbbox((0, 0), tagline, font=feature_font)
tw = bbox[2] - bbox[0]
draw.text(((width - tw) // 2, 530), tagline, fill=dim_text, font=feature_font)

# Bottom accent line gradient
for x in range(width):
    r = int(88 + (accent[0] - 88) * x / width)
    g = int(166 + (accent[1] - 166) * x / width)
    b = int(255 + (accent[2] - 255) * x / width)
    for y in range(637, 640):
        draw.point((x, y), fill=(r, g, b))

img.save("images/banner.png", "PNG")
print(f"Banner created: {img.size[0]}x{img.size[1]}")
