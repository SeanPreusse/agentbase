#!/usr/bin/env python3
"""Build the README GIF from unaltered live inspector captures.

Requires Pillow. Capture graph.png and kanban.png from the same demo project
before rebuilding the GIF. No product UI or MCP response is recreated here.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "docs/screenshots/showcase.gif"
SIZE = (1200, 717)
FONT_DIR = Path("/System/Library/Fonts/Supplemental")
REGULAR = ImageFont.truetype(str(FONT_DIR / "Arial.ttf"), 25)
BOLD = FONT_DIR / "Arial Bold.ttf"


def cover():
    frame = Image.new("RGB", SIZE, "#0b1015")
    draw = ImageDraw.Draw(frame)
    logo = Image.open(ROOT / "assets/logo.png").convert("RGBA")
    logo = logo.resize((92, 92), Image.Resampling.LANCZOS)
    frame.paste(logo, (72, 65), logo)
    draw.text((190, 78), "AgentBase", font=ImageFont.truetype(str(BOLD), 58),
              fill="#f1f5f5")
    draw.rounded_rectangle((72, 238, 145, 243), radius=2, fill="#72d0c2")
    title = ImageFont.truetype(str(BOLD), 61)
    draw.text((72, 275), "Project state for", font=title, fill="#f1f5f5")
    draw.text((72, 350), "coding agents.", font=title, fill="#f1f5f5")
    draw.text((74, 472), "Tasks, decisions, sources and handoffs through local MCP.",
              font=REGULAR, fill="#aebec2")
    draw.text((74, 596), "CODEX  /  CLAUDE CODE",
              font=ImageFont.truetype(str(BOLD), 17), fill="#73cbbf")
    draw.text((1128, 596), "OPEN SOURCE  ·  APACHE 2.0",
              font=ImageFont.truetype(str(BOLD), 17), fill="#73cbbf",
              anchor="ra")
    return frame


graph = Image.open(ROOT / "docs/screenshots/graph.png").convert("RGB")
tasks = Image.open(ROOT / "docs/screenshots/kanban.png").convert("RGB")
frames = [
    cover(),
    graph.resize(SIZE, Image.Resampling.LANCZOS),
    tasks.resize(SIZE, Image.Resampling.LANCZOS),
]
durations = [1400, 2800, 2800]
palette_frames = [
    frame.quantize(colors=96, method=Image.Quantize.MEDIANCUT,
                   dither=Image.Dither.NONE) for frame in frames
]
palette_frames[0].save(OUTPUT, save_all=True,
                       append_images=palette_frames[1:],
                       duration=durations, loop=0, optimize=True, disposal=2)
print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size // 1024} KiB)")
