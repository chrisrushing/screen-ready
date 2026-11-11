"""
What a screen reader gets from a tagged PDF: walks the structure tree in order and pulls the real
text out of each marked-content run (decoded through the font's ToUnicode map, the way assistive
tech does), so the reading order can be checked by reading it.
"""
import sys, re
import pikepdf

from pdftext import page_text_by_mcid

pdf = pikepdf.Pdf.open(sys.argv[1])
pages = {p.objgen: i for i, p in enumerate(pdf.pages)}
texts = [page_text_by_mcid(p) for p in pdf.pages]
root = pdf.Root.StructTreeRoot

def kids(o):
    k = o.get("/K")
    return [] if k is None else (list(k) if isinstance(k, pikepdf.Array) else [k])

print(f"Title: {pdf.docinfo.get('/Title')}   Language: {pdf.Root.get('/Lang')}\n")
n = 0
def text_of(e, pg):
    """What a screen reader says for an element: /ActualText if present, else the glyphs, in order."""
    at = e.get("/ActualText")
    if at is not None: return re.sub(r"\s+", " ", str(at)).strip()
    out = []
    for c in kids(e):
        if isinstance(c, int): out.append(texts[pg].get(int(c), ""))
        elif isinstance(c, pikepdf.Dictionary) and "/S" in c: out.append(text_of(c, pg))
    return re.sub(r"\s+", " ", " ".join(out)).strip()

def say(line):
    global n
    n += 1
    print(f"{n:>3}. {line}")

def walk(e, depth=0):
    s = str(e.S)[1:]
    pg = pages.get(e.Pg.objgen) if "/Pg" in e else None
    if s == "Document":
        for c in kids(e): walk(c, depth)
    elif s in ("Sect", "Part", "Div"):
        print(f"\n— {s}: {e.get('/T', '')} —")
        for c in kids(e): walk(c, depth + 1)
    elif s == "Figure":
        say(f"[Image] {e.get('/Alt')}")
    elif s == "Table":
        rows = [r for r in kids(e) if isinstance(r, pikepdf.Dictionary)]
        cols = max(len([c for c in kids(r) if isinstance(c, pikepdf.Dictionary)]) for r in rows)
        say(f"Table, {len(rows)} rows, {cols} columns")
        for r in rows:
            cells = [c for c in kids(r) if isinstance(c, pikepdf.Dictionary)]
            parts = []
            for c in cells:
                scope = str(c.get("/A", {}).get("/Scope", ""))[1:]
                t = text_of(c, pages.get(c.Pg.objgen))
                parts.append(f"[{str(c.S)[1:]}{'·' + scope if scope else ''}] {t or '(empty)'}")
            print("       " + " | ".join(parts))
    elif s == "L":
        items = [i for i in kids(e) if isinstance(i, pikepdf.Dictionary)]
        numbering = str(e.get("/A", {}).get("/ListNumbering", ""))[1:]
        say(f"List, {len(items)} items" + (f" ({numbering})" if numbering else ""))
        for li in items:
            parts = {str(c.S)[1:]: text_of(c, pages.get(c.Pg.objgen)) for c in kids(li) if isinstance(c, pikepdf.Dictionary)}
            print(f"       • {(parts.get('Lbl', '') + ' ') if parts.get('Lbl') else ''}{parts.get('LBody', '')}")
    else:
        links = [c for c in kids(e) if isinstance(c, pikepdf.Dictionary) and str(c.get("/S")) == "/Link"]
        label = f"Heading level {s[1]}" if re.fullmatch(r"H[1-6]", s) else "Text"
        say(f"{label}: {text_of(e, pg)}" + "".join(f"   [link: {text_of(l, pg)}]" for l in links))
for k in kids(root): walk(k)
