"""Icon rendering for the preview canvas and the structure tree.

Office keeps its ``imageMso`` artwork inside the running application, so an
external editor cannot show the real pictures.  Instead of drawing grey
boxes we recognise the name and paint a matching vector glyph, falling back
to a tinted monogram derived from the id.  Embedded pictures from the
package are shown for real.
"""

from __future__ import annotations

import hashlib
import io
import re
import tkinter as tk
from typing import Callable, Dict, List, Optional, Tuple

try:  # Pillow is optional - it only improves scaling quality.
    from PIL import Image, ImageTk  # type: ignore
    HAVE_PIL = True
except Exception:  # pragma: no cover - depends on the machine
    HAVE_PIL = False

Painter = Callable[[tk.Canvas, float, float, float, str, str, tuple], None]

_PALETTE = [
    "#4C8BF5", "#2FA26A", "#E0A13A", "#D8604C", "#9A7BEA",
    "#2FB3A6", "#E0728F", "#6B8AB8", "#C58A3B", "#5EA35E",
]


def tint_for(name: str) -> str:
    digest = hashlib.md5((name or "?").encode("utf-8")).digest()
    return _PALETTE[digest[0] % len(_PALETTE)]


def monogram(name: str) -> str:
    if not name:
        return "?"
    parts = re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z]*|\d+", name) or [name]
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[1][0]).upper()


# --------------------------------------------------------------------- glyphs
def _rect(cv, x, y, w, h, fill, outline="", tags=(), width=1):
    return cv.create_rectangle(x, y, x + w, y + h, fill=fill, outline=outline or fill,
                               width=width, tags=tags)


def _line(cv, pts, fill, tags=(), width=1.4, **kw):
    return cv.create_line(*pts, fill=fill, width=width, tags=tags, **kw)


def _oval(cv, x, y, w, h, fill, outline="", tags=(), width=1.4):
    return cv.create_oval(x, y, x + w, y + h, fill=fill, outline=outline or fill,
                          width=width, tags=tags)


def _poly(cv, pts, fill, tags=(), outline="", width=1.0):
    return cv.create_polygon(*pts, fill=fill, outline=outline or fill, width=width, tags=tags)


def _text(cv, x, y, s, label, fill, tags=(), weight="bold"):
    return cv.create_text(x + s / 2, y + s / 2, text=label, fill=fill, tags=tags,
                          font=("Segoe UI", max(6, int(s * 0.52)), weight))


def _g_save(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .1, y + s * .12, s * .8, s * .76, fg, tags=tags)
    _rect(cv, x + s * .26, y + s * .12, s * .48, s * .3, bg, tags=tags)
    _rect(cv, x + s * .24, y + s * .56, s * .52, s * .32, bg, tags=tags)
    _rect(cv, x + s * .56, y + s * .17, s * .1, s * .2, fg, tags=tags)


def _g_open(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .08, y + s * .78, x + s * .08, y + s * .24, x + s * .42, y + s * .24,
               x + s * .52, y + s * .36, x + s * .86, y + s * .36, x + s * .86, y + s * .78], fg, tags)
    _poly(cv, [x + s * .08, y + s * .8, x + s * .24, y + s * .48, x + s * .96, y + s * .48,
               x + s * .8, y + s * .8], bg, tags, outline=fg, width=1.2)


def _g_page(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .2, y + s * .1, x + s * .62, y + s * .1, x + s * .82, y + s * .3,
               x + s * .82, y + s * .9, x + s * .2, y + s * .9], bg, tags, outline=fg, width=1.5)
    _poly(cv, [x + s * .62, y + s * .1, x + s * .62, y + s * .3, x + s * .82, y + s * .3], fg, tags)
    for i in range(3):
        _line(cv, [x + s * .32, y + s * (.46 + i * .14), x + s * .7, y + s * (.46 + i * .14)], fg, tags)


def _g_print(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .26, y + s * .12, s * .48, s * .24, bg, outline=fg, tags=tags, width=1.4)
    _rect(cv, x + s * .12, y + s * .36, s * .76, s * .32, fg, tags=tags)
    _rect(cv, x + s * .26, y + s * .6, s * .48, s * .3, bg, outline=fg, tags=tags, width=1.4)


def _g_copy(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .14, y + s * .1, s * .5, s * .62, bg, outline=fg, tags=tags, width=1.4)
    _rect(cv, x + s * .34, y + s * .28, s * .5, s * .62, bg, outline=fg, tags=tags, width=1.6)


def _g_cut(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .24, y + s * .12, x + s * .72, y + s * .68], fg, tags)
    _line(cv, [x + s * .76, y + s * .12, x + s * .28, y + s * .68], fg, tags)
    _oval(cv, x + s * .14, y + s * .64, s * .24, s * .24, bg, fg, tags)
    _oval(cv, x + s * .62, y + s * .64, s * .24, s * .24, bg, fg, tags)


def _g_clipboard(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .18, y + s * .16, s * .64, s * .74, bg, outline=fg, tags=tags, width=1.5)
    _rect(cv, x + s * .34, y + s * .08, s * .32, s * .16, fg, tags=tags)
    for i in range(3):
        _line(cv, [x + s * .3, y + s * (.42 + i * .14), x + s * .7, y + s * (.42 + i * .14)], fg, tags)


def _g_undo(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .12, y + s * .2, x + s * .88, y + s * .96, start=20, extent=140,
                  style="arc", outline=fg, width=max(1.6, s * .1), tags=tags)
    _poly(cv, [x + s * .1, y + s * .2, x + s * .42, y + s * .28, x + s * .18, y + s * .5], fg, tags)


def _g_redo(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .12, y + s * .2, x + s * .88, y + s * .96, start=20, extent=140,
                  style="arc", outline=fg, width=max(1.6, s * .1), tags=tags)
    _poly(cv, [x + s * .9, y + s * .2, x + s * .58, y + s * .28, x + s * .82, y + s * .5], fg, tags)


def _g_play(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .28, y + s * .14, x + s * .84, y + s * .5, x + s * .28, y + s * .86], fg, tags)


def _g_refresh(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .14, y + s * .14, x + s * .86, y + s * .86, start=30, extent=270,
                  style="arc", outline=fg, width=max(1.6, s * .11), tags=tags)
    _poly(cv, [x + s * .78, y + s * .04, x + s * .96, y + s * .34, x + s * .6, y + s * .3], fg, tags)


def _g_chart(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .16, y + s * .5, s * .16, s * .38, fg, tags=tags)
    _rect(cv, x + s * .42, y + s * .3, s * .16, s * .58, fg, tags=tags)
    _rect(cv, x + s * .68, y + s * .14, s * .16, s * .74, fg, tags=tags)


def _g_pie(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .1, y + s * .1, x + s * .9, y + s * .9, start=45, extent=270,
                  fill=fg, outline=fg, tags=tags)
    cv.create_arc(x + s * .14, y + s * .06, x + s * .94, y + s * .86, start=-45, extent=90,
                  fill=bg, outline=fg, tags=tags)


def _g_table(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .12, y + s * .16, s * .76, s * .68, bg, outline=fg, tags=tags, width=1.5)
    _rect(cv, x + s * .12, y + s * .16, s * .76, s * .18, fg, tags=tags)
    _line(cv, [x + s * .12, y + s * .56, x + s * .88, y + s * .56], fg, tags)
    _line(cv, [x + s * .38, y + s * .34, x + s * .38, y + s * .84], fg, tags)
    _line(cv, [x + s * .63, y + s * .34, x + s * .63, y + s * .84], fg, tags)


def _g_filter(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .12, y + s * .16, x + s * .88, y + s * .16, x + s * .58, y + s * .52,
               x + s * .58, y + s * .88, x + s * .42, y + s * .78, x + s * .42, y + s * .52], fg, tags)


def _g_sort(cv, x, y, s, fg, bg, tags):
    for i, w in enumerate((.5, .38, .26)):
        _line(cv, [x + s * .12, y + s * (.26 + i * .24), x + s * (.12 + w), y + s * (.26 + i * .24)],
              fg, tags, width=max(1.4, s * .09))
    _poly(cv, [x + s * .78, y + s * .86, x + s * .66, y + s * .58, x + s * .9, y + s * .58], fg, tags)
    _line(cv, [x + s * .78, y + s * .58, x + s * .78, y + s * .14], fg, tags, width=max(1.4, s * .08))


def _g_search(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .12, y + s * .12, s * .52, s * .52, bg, fg, tags, width=max(1.5, s * .09))
    _line(cv, [x + s * .6, y + s * .6, x + s * .9, y + s * .9], fg, tags, width=max(1.8, s * .11))


def _g_gear(cv, x, y, s, fg, bg, tags):
    import math
    cx, cy, r = x + s / 2, y + s / 2, s * .34
    points: List[float] = []
    for i in range(16):
        angle = math.pi * 2 * i / 16
        radius = r if i % 2 == 0 else r * .66
        points.extend([cx + math.cos(angle) * radius, cy + math.sin(angle) * radius])
    _poly(cv, points, fg, tags)
    _oval(cv, cx - s * .13, cy - s * .13, s * .26, s * .26, bg, tags=tags)


def _g_star(cv, x, y, s, fg, bg, tags):
    import math
    cx, cy = x + s / 2, y + s / 2
    points: List[float] = []
    for i in range(10):
        angle = -math.pi / 2 + math.pi * i / 5
        radius = s * .44 if i % 2 == 0 else s * .19
        points.extend([cx + math.cos(angle) * radius, cy + math.sin(angle) * radius])
    _poly(cv, points, fg, tags)


def _g_check(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .16, y + s * .52, x + s * .42, y + s * .78, x + s * .86, y + s * .2],
          fg, tags, width=max(2.0, s * .14), capstyle="round", joinstyle="round")


def _g_cross(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .2, y + s * .2, x + s * .8, y + s * .8], fg, tags, width=max(2.0, s * .13), capstyle="round")
    _line(cv, [x + s * .8, y + s * .2, x + s * .2, y + s * .8], fg, tags, width=max(2.0, s * .13), capstyle="round")


def _g_plus(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .5, y + s * .16, x + s * .5, y + s * .84], fg, tags, width=max(2.0, s * .14))
    _line(cv, [x + s * .16, y + s * .5, x + s * .84, y + s * .5], fg, tags, width=max(2.0, s * .14))


def _g_calendar(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .12, y + s * .2, s * .76, s * .68, bg, outline=fg, tags=tags, width=1.5)
    _rect(cv, x + s * .12, y + s * .2, s * .76, s * .18, fg, tags=tags)
    _line(cv, [x + s * .3, y + s * .1, x + s * .3, y + s * .28], fg, tags, width=max(1.4, s * .1))
    _line(cv, [x + s * .7, y + s * .1, x + s * .7, y + s * .28], fg, tags, width=max(1.4, s * .1))
    for row in range(2):
        for col in range(3):
            _rect(cv, x + s * (.22 + col * .21), y + s * (.5 + row * .17), s * .12, s * .1, fg, tags=tags)


def _g_clock(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .1, y + s * .1, s * .8, s * .8, bg, fg, tags, width=max(1.5, s * .09))
    _line(cv, [x + s * .5, y + s * .5, x + s * .5, y + s * .26], fg, tags, width=max(1.4, s * .08))
    _line(cv, [x + s * .5, y + s * .5, x + s * .7, y + s * .6], fg, tags, width=max(1.4, s * .08))


def _g_mail(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .1, y + s * .24, s * .8, s * .52, bg, outline=fg, tags=tags, width=1.5)
    _line(cv, [x + s * .1, y + s * .24, x + s * .5, y + s * .56, x + s * .9, y + s * .24], fg, tags)


def _g_link(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .06, y + s * .34, x + s * .58, y + s * .86, start=45, extent=180,
                  style="arc", outline=fg, width=max(1.8, s * .11), tags=tags)
    cv.create_arc(x + s * .42, y + s * .14, x + s * .94, y + s * .66, start=225, extent=180,
                  style="arc", outline=fg, width=max(1.8, s * .11), tags=tags)


def _g_image(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .1, y + s * .18, s * .8, s * .64, bg, outline=fg, tags=tags, width=1.5)
    _oval(cv, x + s * .22, y + s * .28, s * .16, s * .16, fg, tags=tags)
    _poly(cv, [x + s * .14, y + s * .78, x + s * .42, y + s * .46, x + s * .62, y + s * .68,
               x + s * .72, y + s * .58, x + s * .86, y + s * .78], fg, tags)


def _g_lock(cv, x, y, s, fg, bg, tags):
    cv.create_arc(x + s * .26, y + s * .12, x + s * .74, y + s * .6, start=0, extent=180,
                  style="arc", outline=fg, width=max(1.8, s * .1), tags=tags)
    _rect(cv, x + s * .2, y + s * .42, s * .6, s * .44, fg, tags=tags)


def _g_warning(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .5, y + s * .1, x + s * .94, y + s * .86, x + s * .06, y + s * .86], fg, tags)
    _line(cv, [x + s * .5, y + s * .38, x + s * .5, y + s * .62], bg, tags, width=max(1.6, s * .1))
    _rect(cv, x + s * .46, y + s * .68, s * .08, s * .08, bg, tags=tags)


def _g_info(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .1, y + s * .1, s * .8, s * .8, fg, tags=tags)
    _rect(cv, x + s * .45, y + s * .26, s * .1, s * .1, bg, tags=tags)
    _rect(cv, x + s * .45, y + s * .42, s * .1, s * .32, bg, tags=tags)


def _g_bulb(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .22, y + s * .1, s * .56, s * .56, fg, tags=tags)
    _rect(cv, x + s * .38, y + s * .6, s * .24, s * .18, fg, tags=tags)
    _rect(cv, x + s * .4, y + s * .8, s * .2, s * .08, fg, tags=tags)


def _g_palette(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .08, y + s * .08, s * .84, s * .84, fg, tags=tags)
    for dx, dy in ((.28, .26), (.56, .22), (.7, .46), (.3, .58)):
        _oval(cv, x + s * dx, y + s * dy, s * .16, s * .16, bg, tags=tags)


def _g_pencil(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .16, y + s * .84, x + s * .26, y + s * .58, x + s * .74, y + s * .1,
               x + s * .9, y + s * .26, x + s * .42, y + s * .74], fg, tags)
    _poly(cv, [x + s * .16, y + s * .84, x + s * .3, y + s * .8, x + s * .2, y + s * .7], bg, tags, outline=fg)


def _g_trash(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .22, y + s * .26, s * .56, s * .62, bg, outline=fg, tags=tags, width=1.5)
    _rect(cv, x + s * .14, y + s * .16, s * .72, s * .12, fg, tags=tags)
    for i in range(3):
        _line(cv, [x + s * (.34 + i * .16), y + s * .38, x + s * (.34 + i * .16), y + s * .76], fg, tags)


def _g_download(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .5, y + s * .12, x + s * .5, y + s * .62], fg, tags, width=max(1.8, s * .11))
    _poly(cv, [x + s * .28, y + s * .48, x + s * .72, y + s * .48, x + s * .5, y + s * .78], fg, tags)
    _line(cv, [x + s * .16, y + s * .88, x + s * .84, y + s * .88], fg, tags, width=max(1.6, s * .1))


def _g_upload(cv, x, y, s, fg, bg, tags):
    _line(cv, [x + s * .5, y + s * .34, x + s * .5, y + s * .84], fg, tags, width=max(1.8, s * .11))
    _poly(cv, [x + s * .28, y + s * .46, x + s * .72, y + s * .46, x + s * .5, y + s * .14], fg, tags)
    _line(cv, [x + s * .16, y + s * .92, x + s * .84, y + s * .92], fg, tags, width=max(1.6, s * .1))


def _g_eye(cv, x, y, s, fg, bg, tags):
    _poly(cv, [x + s * .06, y + s * .5, x + s * .3, y + s * .22, x + s * .7, y + s * .22,
               x + s * .94, y + s * .5, x + s * .7, y + s * .78, x + s * .3, y + s * .78], bg, tags,
          outline=fg, width=1.5)
    _oval(cv, x + s * .38, y + s * .38, s * .24, s * .24, fg, tags=tags)


def _g_speech(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .1, y + s * .16, s * .8, s * .5, bg, outline=fg, tags=tags, width=1.5)
    _poly(cv, [x + s * .26, y + s * .64, x + s * .26, y + s * .88, x + s * .5, y + s * .64], fg, tags)


def _g_grid(cv, x, y, s, fg, bg, tags):
    _rect(cv, x + s * .12, y + s * .12, s * .76, s * .76, bg, outline=fg, tags=tags, width=1.5)
    _line(cv, [x + s * .12, y + s * .38, x + s * .88, y + s * .38], fg, tags)
    _line(cv, [x + s * .12, y + s * .63, x + s * .88, y + s * .63], fg, tags)
    _line(cv, [x + s * .38, y + s * .12, x + s * .38, y + s * .88], fg, tags)
    _line(cv, [x + s * .63, y + s * .12, x + s * .63, y + s * .88], fg, tags)


def _g_smile(cv, x, y, s, fg, bg, tags):
    _oval(cv, x + s * .08, y + s * .08, s * .84, s * .84, fg, tags=tags)
    _oval(cv, x + s * .3, y + s * .3, s * .1, s * .14, bg, tags=tags)
    _oval(cv, x + s * .6, y + s * .3, s * .1, s * .14, bg, tags=tags)
    cv.create_arc(x + s * .24, y + s * .38, x + s * .76, y + s * .8, start=200, extent=140,
                  style="arc", outline=bg, width=max(1.6, s * .1), tags=tags)


def _letter(label: str) -> Painter:
    def painter(cv, x, y, s, fg, bg, tags):
        _text(cv, x, y, s, label, fg, tags)
    return painter


GLYPHS: Dict[str, Painter] = {
    "save": _g_save, "open": _g_open, "page": _g_page, "print": _g_print,
    "copy": _g_copy, "cut": _g_cut, "clipboard": _g_clipboard, "undo": _g_undo,
    "redo": _g_redo, "play": _g_play, "refresh": _g_refresh, "chart": _g_chart,
    "pie": _g_pie, "table": _g_table, "filter": _g_filter, "sort": _g_sort,
    "search": _g_search, "gear": _g_gear, "star": _g_star, "check": _g_check,
    "cross": _g_cross, "plus": _g_plus, "calendar": _g_calendar, "clock": _g_clock,
    "mail": _g_mail, "link": _g_link, "image": _g_image, "lock": _g_lock,
    "warning": _g_warning, "info": _g_info, "bulb": _g_bulb, "palette": _g_palette,
    "pencil": _g_pencil, "trash": _g_trash, "download": _g_download, "upload": _g_upload,
    "eye": _g_eye, "speech": _g_speech, "grid": _g_grid, "smile": _g_smile,
    "bold": _letter("B"), "italic": _letter("I"), "underline": _letter("U"),
    "sigma": _letter("Σ"), "percent": _letter("%"), "currency": _letter("$"),
    "fx": _letter("fx"), "code": _letter("<>"), "text": _letter("A"),
}

# Two passes: a specific noun ("chart", "table") always beats a generic verb
# ("insert", "new"), otherwise every *Insert command would look identical.
_PRIMARY_RULES: Tuple[Tuple[str, str], ...] = (
    ("autosum", "sigma"), ("sum", "sigma"),
    ("saveas", "save"), ("save", "save"),
    ("openrecent", "open"), ("fileopen", "open"), ("folder", "open"),
    ("printpreview", "print"), ("print", "print"),
    ("pastespecial", "clipboard"), ("paste", "clipboard"),
    ("copy", "copy"), ("cut", "cut"), ("clipboard", "clipboard"),
    ("undo", "undo"), ("redo", "redo"), ("repeat", "redo"),
    ("macro", "play"), ("run", "play"), ("play", "play"), ("calculatenow", "play"),
    ("refresh", "refresh"), ("recalc", "refresh"), ("calculate", "refresh"),
    ("reapply", "refresh"),
    ("piechart", "pie"), ("charttypepie", "pie"), ("pie", "pie"),
    ("charttype", "chart"), ("chartarea", "chart"), ("charttools", "chart"),
    ("chart", "chart"), ("sparkline", "chart"), ("graph", "chart"),
    ("pivottable", "table"), ("table", "table"), ("list", "grid"), ("slicer", "filter"),
    ("filter", "filter"), ("sort", "sort"),
    ("find", "search"), ("search", "search"), ("zoom", "search"), ("lookup", "search"),
    ("options", "gear"), ("settings", "gear"), ("properties", "gear"),
    ("favorite", "star"), ("star", "star"), ("quickaccess", "star"),
    ("accept", "check"), ("complete", "check"), ("check", "check"), ("validat", "check"),
    ("cancel", "cross"), ("delete", "cross"), ("remove", "cross"), ("decline", "cross"),
    ("clear", "trash"), ("trash", "trash"),
    ("calendar", "calendar"), ("date", "calendar"), ("today", "calendar"),
    ("clock", "clock"), ("time", "clock"), ("history", "clock"), ("recent", "clock"),
    ("mail", "mail"), ("send", "mail"), ("message", "mail"), ("reply", "mail"),
    ("hyperlink", "link"), ("link", "link"), ("connection", "link"),
    ("picture", "image"), ("image", "image"), ("photo", "image"), ("clipart", "image"),
    ("shape", "image"), ("smartart", "image"), ("screenshot", "image"),
    ("protect", "lock"), ("lock", "lock"), ("permission", "lock"), ("encrypt", "lock"),
    ("security", "lock"),
    ("warning", "warning"), ("error", "warning"), ("alert", "warning"),
    ("info", "info"), ("help", "info"), ("about", "info"),
    ("lightbulb", "bulb"), ("idea", "bulb"), ("suggest", "bulb"),
    ("cellstyles", "palette"), ("themecolors", "palette"),
    ("theme", "palette"), ("color", "palette"), ("fill", "palette"),
    ("pencil", "pencil"), ("draw", "pencil"), ("pen", "pencil"), ("comment", "speech"),
    ("export", "download"), ("download", "download"), ("publish", "download"),
    ("import", "upload"), ("upload", "upload"), ("getexternal", "upload"),
    ("preview", "eye"), ("watch", "eye"), ("eye", "eye"),
    ("note", "speech"), ("chat", "speech"),
    ("cells", "grid"), ("row", "grid"), ("column", "grid"), ("sheet", "grid"),
    ("grid", "grid"), ("workbook", "grid"), ("border", "grid"), ("merge", "grid"),
    ("outline", "grid"), ("freezepanes", "grid"), ("window", "grid"),
    ("happy", "smile"), ("face", "smile"), ("smile", "smile"),
    ("bold", "bold"), ("italic", "italic"), ("underline", "underline"),
    ("percent", "percent"), ("currency", "currency"), ("accounting", "currency"),
    ("function", "fx"), ("formula", "fx"), ("name", "fx"), ("decimals", "percent"),
    ("xml", "code"), ("visualbasic", "code"), ("code", "code"), ("script", "code"),
    ("control", "code"),
    ("spelling", "text"), ("thesaurus", "text"), ("translate", "text"),
    ("font", "text"), ("align", "text"), ("wraptext", "text"), ("indent", "text"),
    ("orientation", "text"), ("case", "text"), ("highlight", "text"),
    ("report", "page"), ("document", "page"), ("file", "page"),
    ("validation", "check"), ("duplicate", "copy"), ("consolidate", "grid"),
    ("trace", "link"), ("goalseek", "search"), ("whatif", "bulb"),
)

_FALLBACK_RULES: Tuple[Tuple[str, str], ...] = (
    ("insert", "plus"), ("new", "plus"), ("add", "plus"), ("create", "plus"),
    ("design", "pencil"), ("edit", "pencil"), ("modify", "pencil"),
    ("style", "palette"), ("format", "palette"), ("gallery", "palette"),
    ("view", "eye"), ("show", "eye"), ("display", "eye"),
    ("text", "text"), ("label", "text"), ("page", "page"), ("dialog", "gear"),
    ("tools", "gear"), ("advanced", "gear"), ("wizard", "bulb"),
    ("group", "grid"), ("data", "grid"), ("ok", "check"), ("forward", "mail"),
)


def glyph_key(name: str) -> str:
    lowered = (name or "").lower()
    for rules in (_PRIMARY_RULES, _FALLBACK_RULES):
        best, best_len = "", 0
        for needle, glyph in rules:
            if needle in lowered and len(needle) > best_len:
                best, best_len = glyph, len(needle)
        if best:
            return best
    return ""


class IconCache:
    """Renders imageMso icons and embedded pictures onto a canvas.

    Order of preference: the real Office artwork (when the downloadable icon
    pack is installed), then a hand-drawn vector glyph for well-known names,
    then a tinted monogram that is at least never *wrong*.
    """

    def __init__(self, theme) -> None:
        self.theme = theme
        self._photos: Dict[Tuple[int, int], tk.PhotoImage] = {}
        from ..core import msoicons
        self.pack = msoicons.pack()

    def clear(self) -> None:
        self._photos.clear()

    # ------------------------------------------------------------ raster
    def photo(self, data: bytes, size: int) -> Optional[tk.PhotoImage]:
        if not data:
            return None
        key = (hash(data), size)
        if key in self._photos:
            return self._photos[key]
        photo: Optional[tk.PhotoImage] = None
        if HAVE_PIL:
            try:
                image = Image.open(io.BytesIO(data))
                image = image.convert("RGBA")
                image.thumbnail((size, size), Image.LANCZOS)
                photo = ImageTk.PhotoImage(image)
            except Exception:
                photo = None
        if photo is None:
            try:
                photo = tk.PhotoImage(data=data)
                width = max(1, photo.width())
                if width > size:
                    factor = max(1, round(width / size))
                    photo = photo.subsample(factor, factor)
                elif width * 2 <= size:
                    photo = photo.zoom(max(1, size // width))
            except Exception:
                photo = None
        if photo is not None:
            self._photos[key] = photo
        return photo

    # ------------------------------------------------------------- drawing
    def draw(self, canvas: tk.Canvas, x: float, y: float, size: float,
             image_mso: str = "", image_data: Optional[bytes] = None,
             fallback: str = "", tags: tuple = (), muted: bool = False,
             honest: bool = False) -> None:
        """Draw an icon with its top-left corner at (x, y).

        ``honest=True`` (the gallery) never guesses: real artwork or a
        neutral monogram, but no pictogram stand-ins that could suggest the
        wrong picture for a name.
        """
        if image_data:
            photo = self.photo(image_data, int(size))
            if photo is not None:
                canvas.create_image(x + size / 2, y + size / 2, image=photo, tags=tags)
                return

        name = image_mso or fallback or "?"

        if image_mso and self.pack.has(image_mso):
            photo = self.pack.icon(image_mso, int(size))
            if photo is not None:
                # The sprite bakes a white background in, so give the icon a
                # small white chip - it reads as deliberate in both themes.
                pad = max(1.0, size * 0.06)
                _rounded(canvas, x - pad, y - pad, size + 2 * pad, size + 2 * pad,
                         size * 0.18, "#ffffff", tags)
                canvas.create_image(x + size / 2, y + size / 2, image=photo, tags=tags)
                return

        base = tint_for(name)
        if muted:
            base = mix_toward(base, self.theme.c("panel"), 0.45)
        key = "" if honest else glyph_key(name)
        surface = self.theme.c("panel")

        if key:
            painter = GLYPHS[key]
            painter(canvas, x, y, size, base, surface, tags)
            return

        radius = size * 0.22
        _rounded(canvas, x + size * .06, y + size * .06, size * .88, size * .88, radius,
                 mix_toward(base, surface, 0.62), tags)
        canvas.create_text(x + size / 2, y + size / 2 + size * .02, text=monogram(name),
                           fill=base, tags=tags,
                           font=("Segoe UI", max(6, int(size * 0.4)), "bold"))


def _rounded(canvas: tk.Canvas, x, y, w, h, r, fill, tags=(), outline=""):
    r = min(r, w / 2, h / 2)
    points = [
        x + r, y, x + w - r, y, x + w, y, x + w, y + r, x + w, y + h - r,
        x + w, y + h, x + w - r, y + h, x + r, y + h, x, y + h, x, y + h - r,
        x, y + r, x, y,
    ]
    return canvas.create_polygon(points, smooth=True, splinesteps=12, fill=fill,
                                 outline=outline or fill, tags=tags)


def rounded_rect(canvas: tk.Canvas, x, y, w, h, r, fill, tags=(), outline="", width=1):
    r = min(r, w / 2, h / 2)
    points = [
        x + r, y, x + w - r, y, x + w, y, x + w, y + r, x + w, y + h - r,
        x + w, y + h, x + w - r, y + h, x + r, y + h, x, y + h, x, y + h - r,
        x, y + r, x, y,
    ]
    return canvas.create_polygon(points, smooth=True, splinesteps=12, fill=fill,
                                 outline=outline or fill, width=width, tags=tags)


def mix_toward(color: str, target: str, ratio: float) -> str:
    from .theme import mix
    return mix(target, color, ratio)
