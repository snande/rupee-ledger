#!/usr/bin/env python3
"""Check the static app shell against DESIGN.md and the scaffold contract.

Fails (exit 1) when any of these breaks:
  - index.html does not link css/tokens.css and css/controls.css
  - index.html lacks the exact viewport meta tag
  - a DESIGN.md palette, typeface, type-scale or spacing value is missing
    verbatim from a custom property on :root in css/tokens.css
  - button, input, select or textarea lacks appearance: none or its own
    border, background, radius, padding and font in css/controls.css
  - any of those four controls lacks its own :focus-visible or :disabled rule
  - css/controls.css uses a raw value instead of a token, or a var() that
    tokens.css does not define
  - any file references another origin: an http(s):// URL anywhere, or a
    protocol-relative //host in a src, href, @import or url(...)
  - index.html plus everything under css/ is 60 KB (60,000 bytes) or more

Standard library only, so CI needs nothing but python3.

Usage: python3 scripts/check_static_shell.py [repo-root]
"""

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

CONTROLS = ("button", "input", "select", "textarea")
VIEWPORT = "width=device-width, initial-scale=1"
SIZE_LIMIT_BYTES = 60_000

failures = []


def fail(message):
    failures.append(message)


def strip_css_comments(css):
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def css_rules(css):
    """Yield (selectors, declarations) for every innermost { } block."""
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", strip_css_comments(css)):
        selectors = [s.strip() for s in match.group(1).split(",")]
        declarations = {}
        for decl in match.group(2).split(";"):
            if ":" in decl:
                prop, value = decl.split(":", 1)
                declarations[prop.strip().lower()] = " ".join(value.split())
        yield selectors, declarations


# ---------- DESIGN.md ----------


def design_sections(text):
    sections = {}
    current = None
    for line in text.splitlines():
        if line.startswith("## "):
            current = line[3:].strip().lower()
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    return sections


def design_values(design_text):
    sections = design_sections(design_text)
    palette = re.findall(r"`(#[0-9A-Fa-f]{3,8})`", "\n".join(sections.get("palette", [])))
    typefaces = [
        m.group(1).strip()
        for line in sections.get("typefaces", [])
        if (m := re.match(r"-\s+(.+?)\s+—", line))
    ]

    def scale(name):
        return [
            n
            for line in sections.get(name, [])
            if (m := re.match(r"-\s+([\d/]+)\s*$", line))
            for n in m.group(1).split("/")
        ]

    return palette, typefaces, scale("type scale"), scale("spacing scale")


# ---------- index.html ----------


class ShellParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stylesheets = []
        self.viewports = []

    def handle_starttag(self, tag, attrs):
        attrs = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            self.stylesheets.append(attrs.get("href", ""))
        if tag == "meta" and attrs.get("name", "").lower() == "viewport":
            self.viewports.append(attrs.get("content", ""))


def check_index(root):
    index = root / "index.html"
    if not index.is_file():
        fail("index.html is missing at the repository root")
        return
    parser = ShellParser()
    parser.feed(index.read_text(encoding="utf-8"))
    for sheet in ("css/tokens.css", "css/controls.css"):
        if sheet not in parser.stylesheets:
            fail(f'index.html does not load {sheet} with <link rel="stylesheet">')
        elif not (root / sheet).is_file():
            fail(f"index.html links {sheet} but the file does not exist")
    if VIEWPORT not in parser.viewports:
        fail(f'index.html lacks <meta name="viewport" content="{VIEWPORT}">')


# ---------- css/tokens.css ----------


def root_tokens(tokens_css):
    tokens = {}
    for selectors, declarations in css_rules(tokens_css):
        if ":root" in selectors:
            tokens.update({p: v for p, v in declarations.items() if p.startswith("--")})
    return tokens


def check_tokens(root, tokens):
    design = root / "DESIGN.md"
    if not design.is_file():
        fail("DESIGN.md is missing, so the tokens cannot be checked against it")
        return
    palette, typefaces, type_scale, spacing = design_values(design.read_text(encoding="utf-8"))
    for label, found in (
        ("palette", palette),
        ("typefaces", typefaces),
        ("type scale", type_scale),
        ("spacing scale", spacing),
    ):
        if not found:
            fail(f"could not read the {label} section of DESIGN.md")

    values = list(tokens.values())
    for colour in palette:
        if colour not in values:
            fail(f"css/tokens.css has no :root custom property with the value {colour}")
    for face in typefaces:
        stacks = [[f.strip().strip("\"'") for f in v.split(",")] for v in values]
        if not any(face in stack for stack in stacks):
            fail(f'css/tokens.css has no :root font stack that names "{face}"')
    for label, scale in (("type scale", type_scale), ("spacing scale", spacing)):
        for n in scale:
            if n not in values and f"{n}px" not in values:
                fail(f"css/tokens.css has no :root custom property for {label} value {n}")


# ---------- css/controls.css ----------

REQUIRED_PARTS = {
    "border": lambda p: p == "border" or (p.startswith("border-") and p != "border-radius"),
    "background": lambda p: p in ("background", "background-color"),
    "radius": lambda p: p == "border-radius",
    "padding": lambda p: p == "padding" or p.startswith("padding-"),
    "font": lambda p: p in ("font", "font-family"),
}
FOCUS_PROPS = ("outline", "border-color", "box-shadow", "border")
DISABLED_PROPS = ("color", "background", "background-color", "border-color", "border-style", "opacity")
RAW_VALUE = re.compile(r"#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?)\(|\d(?:px|rem|em|pt)\b|[\"']")


def check_controls(root, tokens):
    path = root / "css" / "controls.css"
    if not path.is_file():
        fail("css/controls.css is missing")
        return
    css = path.read_text(encoding="utf-8")
    rules = list(css_rules(css))

    def merged(selector):
        found = {}
        for selectors, declarations in rules:
            if selector in selectors:
                found.update(declarations)
        return found

    for control in CONTROLS:
        base = merged(control)
        if base.get("appearance") != "none":
            fail(f"css/controls.css: {control} does not set appearance: none")
        for part, matches in REQUIRED_PARTS.items():
            if not any(matches(p) for p in base):
                fail(f"css/controls.css: {control} does not define its own {part}")
        focus = merged(f"{control}:focus-visible")
        if not any(p in focus for p in FOCUS_PROPS):
            fail(f"css/controls.css: {control} has no visible :focus-visible rule")
        disabled = merged(f"{control}:disabled")
        if not any(p in disabled for p in DISABLED_PROPS):
            fail(f"css/controls.css: {control} has no visible :disabled rule")

    for selectors, declarations in rules:
        for prop, value in declarations.items():
            if RAW_VALUE.search(value):
                fail(f"css/controls.css: {', '.join(selectors)} {{ {prop}: {value} }} uses a raw value, not a token")
    for name in sorted(set(re.findall(r"var\(\s*(--[\w-]+)", strip_css_comments(css)))):
        if name not in tokens:
            fail(f"css/controls.css uses var({name}), which css/tokens.css does not define on :root")


# ---------- remote references and size ----------

REMOTE_URL = re.compile(r"https?://", re.I)
PROTOCOL_RELATIVE = re.compile(
    r"""(?:\b(?:src|href)\s*=\s*["']?|@import\s+(?:url\()?\s*["']?|\burl\(\s*["']?)\s*//""",
    re.I,
)


def shell_files(root):
    files = [root / "index.html"] if (root / "index.html").is_file() else []
    css_dir = root / "css"
    if css_dir.is_dir():
        files += sorted(p for p in css_dir.rglob("*") if p.is_file())
    return files


def check_remote_refs(root):
    for path in shell_files(root):
        text = path.read_text(encoding="utf-8", errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            if REMOTE_URL.search(line) or PROTOCOL_RELATIVE.search(line):
                fail(f"{path.relative_to(root)}:{lineno} references another origin: {line.strip()}")


def check_size(root):
    total = sum(p.stat().st_size for p in shell_files(root))
    if total >= SIZE_LIMIT_BYTES:
        fail(f"index.html plus css/ is {total} bytes; the limit is under {SIZE_LIMIT_BYTES}")
    return total


def main(argv):
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    tokens_path = root / "css" / "tokens.css"
    tokens = root_tokens(tokens_path.read_text(encoding="utf-8")) if tokens_path.is_file() else {}
    if not tokens_path.is_file():
        fail("css/tokens.css is missing")

    check_index(root)
    check_tokens(root, tokens)
    check_controls(root, tokens)
    check_remote_refs(root)
    total = check_size(root)

    if failures:
        print(f"Static shell check FAILED ({len(failures)} problem(s)):")
        for message in failures:
            print(f"  - {message}")
        return 1
    print(f"Static shell check passed: {len(tokens)} tokens, 4 controls styled, no remote refs, {total} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
