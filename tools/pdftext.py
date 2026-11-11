"""Text per marked-content run, decoded through each font's ToUnicode map."""
import re
import pikepdf

def parse_cmap(stream):
    data = bytes(stream.read_bytes()).decode("latin-1")
    m = {}
    def u(hexstr):
        b = bytes.fromhex(hexstr)
        return b.decode("utf-16-be", errors="replace") if len(b) >= 2 else chr(b[0])
    for block in re.findall(r"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            m[int(src, 16)] = u(dst)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", data, re.S):
        for a, b, rest in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", block):
            a, b = int(a, 16), int(b, 16)
            if rest.startswith("["):
                for i, d in enumerate(re.findall(r"<([0-9A-Fa-f]+)>", rest)):
                    m[a + i] = u(d)
            else:
                base = int(rest[1:-1], 16)
                width = len(rest[1:-1]) // 2
                for i in range(b - a + 1):
                    m[a + i] = u(format(base + i, f"0{width*2}x"))
    return m

def page_text_by_mcid(page):
    fonts = {}
    for name, f in (page.obj.Resources.get("/Font") or {}).items():
        fonts[str(name)] = parse_cmap(f.ToUnicode) if "/ToUnicode" in f else {}
    out, stack, font = {}, [], {}
    need_space = False
    for operands, op in pikepdf.parse_content_stream(page):
        op = str(op)
        if op == "BDC":
            props = operands[1] if len(operands) > 1 else None
            mcid = int(props.get("/MCID")) if isinstance(props, pikepdf.Dictionary) and "/MCID" in props else None
            stack.append(mcid)
        elif op == "BMC":
            stack.append(None)
        elif op == "EMC":
            if stack: stack.pop()
        elif op == "Tf":
            font = fonts.get(str(operands[0]), {})
        elif op in ("Tm", "Td", "TD", "T*"):
            need_space = True
        elif op in ("Tj", "TJ", "'", '"'):
            mcid = next((m for m in reversed(stack) if m is not None), None)
            if mcid is None: continue
            parts = [operands[-1]] if op != "TJ" else list(operands[0])
            text = ""
            for p in parts:
                if isinstance(p, pikepdf.String):
                    text += "".join(font.get(b, "") for b in bytes(p))
            if not text: continue
            cur = out.get(mcid, "")
            if need_space and cur and not cur.endswith(" ") and not text.startswith(" "):
                cur += " "
            out[mcid] = cur + text
            need_space = False
    return out

