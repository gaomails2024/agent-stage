#!/usr/bin/env python3
"""Bake public/characters/<id>/stage.png — full-body contain into 853×1280.

Seat portrait.png is left untouched (often a zoomed upper-body crop).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT_W, OUT_H = 853, 1280
NEAR_WHITE = 245
MARGIN = 8  # px padding around content bbox inside canvas

# Prefer proven full-body sources; missing → contain-fit of current portrait.png
SOURCES: dict[str, Path | None] = {
    "workbuddy": ROOT / "tmp-icons/workbuddy-style/workbuddy-ol-src.png",
    "hermes": ROOT / "tmp-icons/hermes-greek-v3-src.png",
    "codebuddy": ROOT / "tmp-icons/codebuddy-style/codebuddy-ninja-src.png",
    "marvis": ROOT / "tmp-icons/next-marvis-src.png",
    "doubao": ROOT / "tmp-icons/next-seed-src.jpg",
    "grok-bot": ROOT / "tmp-icons/grok.webp",
    "claude-code": ROOT / "tmp-icons/claude.webp",
    "autoclaw": ROOT / "tmp-icons/autoclaw-src.webp",
    "codex": ROOT / "tmp-icons/gpt3-src.png",
    "dsh": ROOT / "tmp-icons/deepseek2.png",
    "default": None,  # fallback to portrait
}


def content_bbox(im: Image.Image, thr: int = NEAR_WHITE) -> tuple[int, int, int, int]:
    rgba = im.convert("RGBA")
    px = rgba.load()
    w, h = rgba.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 20:
                continue
            if r >= thr and g >= thr and b >= thr:
                continue
            if x < minx:
                minx = x
            if y < miny:
                miny = y
            if x > maxx:
                maxx = x
            if y > maxy:
                maxy = y
    if maxx < 0:
        return (0, 0, w, h)
    return (minx, miny, maxx + 1, maxy + 1)


def fit_contain(
    src: Image.Image,
    canvas_w: int = OUT_W,
    canvas_h: int = OUT_H,
    *,
    keep_alpha: bool,
) -> Image.Image:
    bbox = content_bbox(src)
    crop = src.crop(bbox).convert("RGBA")
    cw, ch = crop.size
    # leave a little margin so ears/heels aren't clipped by rounding
    avail_w = canvas_w - 2 * MARGIN
    avail_h = canvas_h - 2 * MARGIN
    scale = min(avail_w / cw, avail_h / ch)
    nw = max(1, int(round(cw * scale)))
    nh = max(1, int(round(ch * scale)))
    resized = crop.resize((nw, nh), Image.Resampling.LANCZOS)
    if keep_alpha:
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 0))
    else:
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 255))
    x = (canvas_w - nw) // 2
    y = (canvas_h - nh) // 2
    canvas.paste(resized, (x, y), resized)
    if keep_alpha:
        return canvas
    return canvas.convert("RGB")


def has_useful_alpha(im: Image.Image) -> bool:
    if im.mode not in ("RGBA", "LA"):
        if im.mode == "P" and "transparency" in im.info:
            return True
        return False
    a = im.getchannel("A")
    # any non-opaque pixel
    extrema = a.getextrema()
    return extrema[0] < 250


def bake_one(char_id: str, src_path: Path | None) -> tuple[str, str]:
    out_dir = ROOT / "public" / "characters" / char_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "stage.png"
    portrait = out_dir / "portrait.png"

    kind = "fullbody"
    if src_path is None or not src_path.exists():
        if not portrait.exists():
            return char_id, "SKIP: no source and no portrait.png"
        src_path = portrait
        kind = "fallback-portrait"

    im = Image.open(src_path)
    keep_alpha = has_useful_alpha(im)
    # For white-bg RGB sources, bake on white (no alpha)
    if kind == "fullbody" and im.mode in ("RGB", "L", "P") and not keep_alpha:
        keep_alpha = False
    result = fit_contain(im, keep_alpha=keep_alpha)
    if result.mode == "RGBA":
        result.save(out_path, "PNG")
    else:
        result.save(out_path, "PNG", optimize=True)
    return char_id, f"{kind} from {src_path.relative_to(ROOT)} → {result.size} mode={result.mode}"


def main() -> None:
    # Also bake any character dirs that exist but aren't in SOURCES
    char_root = ROOT / "public" / "characters"
    ids = sorted({*SOURCES.keys(), *[p.name for p in char_root.iterdir() if p.is_dir()]})
    report = []
    for cid in ids:
        src = SOURCES.get(cid)
        if cid not in SOURCES:
            src = None  # fallback
        cid_out, msg = bake_one(cid, src)
        report.append((cid_out, msg))
        print(f"{cid_out}: {msg}")
    report_path = ROOT / "tmp-icons" / "stage-fullbody-bake-report.txt"
    report_path.write_text("\n".join(f"{a}: {b}" for a, b in report) + "\n")
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
