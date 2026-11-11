"""
Structural checks on a tagged PDF — the machine-checkable subset of what PAC/Acrobat look at for
headings, paragraphs, figures and reading order. Not a substitute for a real checker.
"""
import sys, re
from collections import Counter
import pikepdf

fails, passes = [], []
def check(ok, msg):
    (passes if ok else fails).append(msg)

pdf = pikepdf.Pdf.open(sys.argv[1])
root = pdf.Root

# --- document level ---------------------------------------------------------
check(root.get("/MarkInfo", {}).get("/Marked") is True, "MarkInfo /Marked true")
check("/Lang" in root and str(root.Lang).strip() != "", f"catalog /Lang = {root.get('/Lang')}")
check(bool(root.get("/ViewerPreferences", {}).get("/DisplayDocTitle")), "ViewerPreferences /DisplayDocTitle true")
title = pdf.docinfo.get("/Title") if pdf.docinfo else None
check(title is not None and str(title).strip() != "", f"Info /Title = {title}")
xmp = bytes(root.Metadata.read_bytes()) if "/Metadata" in root else b""
check(b"<pdfuaid:part>1</pdfuaid:part>" in xmp, "XMP declares pdfuaid:part 1")
check("/Filter" not in root.Metadata if "/Metadata" in root else False, "XMP stream is uncompressed")

# --- structure tree ---------------------------------------------------------
st = root.StructTreeRoot
def kids(o):
    k = o.get("/K")
    if k is None: return []
    return list(k) if isinstance(k, pikepdf.Array) else [k]

reachable = set()      # objgen of every StructElem reachable from the root
order = []             # (S, page_index, mcid, elem) in tree order
elems = []             # every element's role, in tree order (a heading made of spans counts too)
page_index = {p.objgen: i for i, p in enumerate(pdf.pages)}
def walk(o, parent=None):
    if isinstance(o, pikepdf.Dictionary) and "/S" in o:
        reachable.add(o.objgen)
        elems.append(str(o.S))
        if parent is not None:
            check(o.get("/P") is not None and o.P.objgen == parent.objgen,
                  f"/P back-pointer correct on {o.S}") if False else None
            if o.get("/P") is None or o.P.objgen != parent.objgen:
                fails.append(f"{o.S} has wrong /P back-pointer")
        for c in kids(o):
            if isinstance(c, int):
                pg = o.get("/Pg")
                order.append((str(o.S), page_index.get(pg.objgen) if pg is not None else None, int(c), o))
            else:
                walk(c, o)
for c in kids(st): walk(c)

roles = Counter(s for s, *_ in order)
print("roles in reading order:", dict(roles))

# heading levels must not skip on the way down
prev = 0
skips = []
for s in elems:
    m = re.fullmatch(r"/H([1-6])", s)
    if m:
        lvl = int(m.group(1))
        if prev and lvl > prev + 1: skips.append(f"{s} after H{prev}")
        prev = lvl
check(not skips, "heading levels never skip" + (f": {skips}" if skips else ""))
check(elems.count("/H1") >= 1, "at least one H1")

# figures
figs = [e for s, _, _, e in order if s == "/Figure"]
for f in figs:
    alt = f.get("/Alt")
    check(alt is not None and str(alt).strip() != "", f"Figure has /Alt: {str(alt)[:70]!r}")
    a = f.get("/A")
    check(a is not None and a.get("/O") == pikepdf.Name("/Layout") and len(a.get("/BBox", [])) == 4,
          f"Figure has /A /O /Layout /BBox {list(a.BBox) if a is not None and '/BBox' in a else None}")

# --- per page: content stream vs ParentTree ---------------------------------
nums = st.ParentTree.Nums
pt = {int(nums[i]): nums[i+1] for i in range(0, len(nums), 2)}
sp_seen = Counter()
for i, page in enumerate(pdf.pages):
    sp = page.obj.get("/StructParents")
    check(sp is not None, f"page {i} has /StructParents")
    if sp is None: continue
    sp = int(sp); sp_seen[sp] += 1
    check(page.obj.get("/Tabs") == pikepdf.Name("/S"), f"page {i} /Tabs /S")

    c = page.obj.Contents
    data = b"".join(bytes(s.read_bytes()) for s in c) if isinstance(c, pikepdf.Array) else bytes(c.read_bytes())

    # balanced marked content, no MCID inside an artifact, every Do classified
    depth, stack, mcids, bad = 0, [], [], []
    for m in re.finditer(rb"/(\w+)\s*(<<[^>]*>>)?\s*(BDC|BMC)|\bEMC\b|/(\w+)\s+Do\b", data):
        t = m.group(0)
        if t.endswith((b"BDC", b"BMC")):
            tag = m.group(1).decode()
            mm = re.search(rb"/MCID\s+(\d+)", m.group(2) or b"")
            if mm:
                if "Artifact" in stack: bad.append(f"MCID {mm.group(1).decode()} nested inside an Artifact")
                mcids.append(int(mm.group(1)))
            stack.append(tag)
        elif t == b"EMC":
            if not stack: bad.append("EMC with nothing open")
            else: stack.pop()
        else:
            where = stack[-1] if stack else "UNMARKED"
            name = m.group(4).decode()
            # A form XObject painted outside marked content is fine when its own content is marked
            # (an artifact with figures carved out, tied in through the form's /StructParents).
            xo = page.obj.get("/Resources", {}).get("/XObject", {}).get("/" + name)
            def has_figures(form, depth=0):
                """The form, or a form it draws, carries its own figures (through /StructParents)."""
                if depth > 3: return False
                inner = bytes(form.read_bytes())
                if not re.match(rb"\s*/Artifact\s+BMC", inner): return False
                if "/StructParents" in form and re.search(rb"/Figure\s*<<\s*/MCID", inner): return True
                kids = form.get("/Resources", {}).get("/XObject", {})
                return any(v.get("/Subtype") == "/Form" and has_figures(v, depth + 1) for _, v in kids.items())
            if where == "UNMARKED" and xo is not None and xo.get("/Subtype") == "/Form" and has_figures(xo):
                passes.append(f"page {i + 1}: /{name} is a form with its own figures"); continue
            if where != "Figure" and where != "Artifact": bad.append(f"/{name} Do is {where}")
            if where == "Figure": passes.append(f"page {i}: /{m.group(4).decode()} Do is inside a Figure")
    check(not stack, f"page {i} marked content balanced")
    check(not bad, f"page {i} no marked-content errors" + (f": {bad}" if bad else ""))
    dup = [k for k, v in Counter(mcids).items() if v > 1]
    check(not dup, f"page {i} no duplicate MCIDs" + (f": {dup}" if dup else ""))

    arr = pt.get(sp)
    check(arr is not None, f"page {i} ParentTree entry for key {sp}")
    if arr is None: continue
    check(len(arr) == len(mcids) and sorted(mcids) == list(range(len(mcids))),
          f"page {i} ParentTree length {len(arr)} == MCIDs in stream {len(mcids)} (0..n-1)")
    for mcid in mcids:
        e = arr[mcid] if mcid < len(arr) else None
        if e is None:
            fails.append(f"page {i} MCID {mcid} has no ParentTree entry"); continue
        if e.objgen not in reachable:
            fails.append(f"page {i} MCID {mcid}: ParentTree points at an element not reachable from StructTreeRoot")
        ks = list(e.K) if isinstance(e.K, pikepdf.Array) else [e.K]
        own = [int(k) for k in ks if not isinstance(k, pikepdf.Dictionary)] + \
              [int(k.MCID) for k in ks if isinstance(k, pikepdf.Dictionary) and k.get("/Type") == "/MCR"]
        if mcid not in own:
            fails.append(f"page {i} MCID {mcid}: element /K is {e.K}")
        if e.Pg.objgen != page.obj.objgen:
            fails.append(f"page {i} MCID {mcid}: element /Pg is a different page")
    passes.append(f"page {i}: {len(mcids)} MCIDs all resolve to reachable elements on this page")

    # Every annotation is tagged: its /StructParent leads to an element whose OBJR points back at it.
    for a in page.obj.get("/Annots", []):
        key = a.get("/StructParent")
        e = pt.get(int(key)) if key is not None else None
        objrs = [k for k in (list(e.K) if e is not None and isinstance(e.K, pikepdf.Array) else []) if isinstance(k, pikepdf.Dictionary) and k.get("/Type") == "/OBJR"]
        ok = e is not None and any(o.Obj.objgen == a.objgen for o in objrs)
        check(ok, f"page {i} annotation {a.get('/Subtype')} tagged via /StructParent {key}" + ("" if ok else " — no matching OBJR"))
        if ok: check(str(e.S) == "/Link" and "/Contents" in a, f"page {i} link annotation is a /Link with /Contents")

    fonts = page.obj.Resources.get("/Font", {})
    missing = [str(k) for k, v in fonts.items() if "/ToUnicode" not in v]
    check(not missing, f"page {i} every font has ToUnicode" + (f" (missing {missing})" if missing else ""))

check(all(v == 1 for v in sp_seen.values()), f"/StructParents values unique {dict(sp_seen)}")
check(int(st.ParentTreeNextKey) > max(pt.keys()), f"ParentTreeNextKey {st.ParentTreeNextKey} > max key {max(pt.keys())}")

print(f"\n{len(passes)} passed, {len(fails)} failed\n")
for p in passes: print("  ok  ", p)
for f in fails: print("  FAIL", f)
print("\nreading order:")
for s, pi, mcid, e in order:
    t = e.get("/Alt") if s == "/Figure" else None
    print(f"  p{pi} mcid {mcid:<3} {s:<8} {(str(t)[:60] if t else '')}")
sys.exit(1 if fails else 0)
