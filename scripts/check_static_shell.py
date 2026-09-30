#!/usr/bin/env python3
"""Check the static app shell against DESIGN.md and the scaffold contract.

Fails (exit 1) when any of these breaks:
  - index.html does not link css/tokens.css and css/controls.css
  - index.html lacks the exact viewport meta tag
  - index.html lacks the app frame: a header, then a main, then a nav holding
    at least one <a> or <button> with class "tab"
  - index.html loads no <script type="module"> from a local file that exists
  - a DESIGN.md palette, typeface, type-scale or spacing value is missing
    verbatim from a custom property on :root in css/tokens.css
  - button, input, select or textarea lacks appearance: none or its own
    border, background, radius, padding and font in css/controls.css
  - any of those four controls lacks its own :focus-visible or :disabled rule
  - css/controls.css does not give .tab its own colour, background, padding,
    font and text-decoration, has no [aria-current="page"] active style, or
    does not pin .tab-bar with position: sticky or fixed
  - css/controls.css uses a raw value instead of a token, or a var() that
    tokens.css does not define
  - index.html, css/ or js/ references another origin: an http(s):// URL
    anywhere, or a
    protocol-relative //host in a src, href, @import or url(...)
  - index.html plus everything under css/ is 60 KB (60,000 bytes) or more
  - manifest.webmanifest is missing, is not JSON, lacks name, short_name,
    start_url, scope, background_color, theme_color or an icons array, or
    its display is not standalone
  - the manifest lists no 192x192 or no 512x512 PNG icon, or an icon src
    is not a relative path under icons/, is missing, or is not a PNG of
    the size it claims
  - index.html lacks a relative <link rel="manifest"> to that file, a
    <meta name="theme-color">, or a relative <link rel="apple-touch-icon">
    to a PNG under icons/ that exists
  - manifest.webmanifest or scripts/make_icons.py references another origin

Standard library only, so CI needs nothing but python3.

Usage: python3 scripts/check_static_shell.py [repo-root]
"""

import json
import re
import struct
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


FRAME_PARTS = ("header", "main", "nav")


class ShellParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stylesheets = []
        self.viewports = []
        self.module_scripts = []
        self.frame_order = []
        self.nav_tabs = []
        self.nav_depth = 0
        self.links = []
        self.theme_colors = []

    def handle_starttag(self, tag, attrs):
        attrs = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link" and "stylesheet" in attrs.get("rel", "").lower().split():
            self.stylesheets.append(attrs.get("href", ""))
        if tag == "meta" and attrs.get("name", "").lower() == "viewport":
            self.viewports.append(attrs.get("content", ""))
        if tag == "meta" and attrs.get("name", "").lower() == "theme-color":
            self.theme_colors.append(attrs.get("content", ""))
        if tag == "link":
            self.links.append((attrs.get("rel", "").lower().split(), attrs.get("href", "")))
        if tag == "script" and attrs.get("type", "").lower() == "module":
            self.module_scripts.append(attrs.get("src", ""))
        if tag in FRAME_PARTS:
            self.frame_order.append(tag)
        if tag == "nav":
            self.nav_depth += 1
        elif self.nav_depth and tag in ("a", "button") and "tab" in attrs.get("class", "").split():
            self.nav_tabs.append(tag)

    def handle_endtag(self, tag):
        if tag == "nav" and self.nav_depth:
            self.nav_depth -= 1


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

    missing = [part for part in FRAME_PARTS if part not in parser.frame_order]
    for part in missing:
        fail(f"index.html has no <{part}> in its app frame")
    if not missing:
        first = [parser.frame_order.index(part) for part in FRAME_PARTS]
        if first != sorted(first):
            fail("index.html frame is out of order: expected <header>, then <main>, then <nav>")
    if not parser.nav_tabs:
        fail('index.html has no <a> or <button> with class "tab" inside <nav>')

    local_modules = [src for src in parser.module_scripts if src]
    if not local_modules:
        fail('index.html loads no <script type="module" src="..."> from the repository')
    for src in local_modules:
        if REMOTE_URL.match(src) or src.startswith("//"):
            fail(f"index.html loads module {src} from another origin")
        elif not (root / src.split("?")[0].split("#")[0]).is_file():
            fail(f"index.html loads module {src} but the file does not exist")


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

    check_frame_styles(rules, merged)

    for selectors, declarations in rules:
        for prop, value in declarations.items():
            if RAW_VALUE.search(value):
                fail(f"css/controls.css: {', '.join(selectors)} {{ {prop}: {value} }} uses a raw value, not a token")
    for name in sorted(set(re.findall(r"var\(\s*(--[\w-]+)", strip_css_comments(css)))):
        if name not in tokens:
            fail(f"css/controls.css uses var({name}), which css/tokens.css does not define on :root")


TAB_PARTS = {
    "colour": lambda p: p == "color",
    "background": REQUIRED_PARTS["background"],
    "padding": REQUIRED_PARTS["padding"],
    "font": REQUIRED_PARTS["font"],
    "text-decoration": lambda p: p in ("text-decoration", "text-decoration-line"),
}
ACTIVE_PROPS = ("color", "background", "background-color", "font-weight", "box-shadow")
ACTIVE_SELECTOR = re.compile(r"\[aria-current=[\"']?page[\"']?\]")


def check_frame_styles(rules, merged):
    tab = merged(".tab")
    for part, matches in TAB_PARTS.items():
        if not any(matches(p) for p in tab):
            fail(f"css/controls.css: .tab does not define its own {part}")
    active = {}
    for selectors, declarations in rules:
        if any(ACTIVE_SELECTOR.search(s) for s in selectors):
            active.update(declarations)
    if not any(p in ACTIVE_PROPS or p.startswith("border") for p in active):
        fail('css/controls.css has no visible [aria-current="page"] style for the active tab')
    if merged(".tab-bar").get("position") not in ("sticky", "fixed"):
        fail("css/controls.css: .tab-bar is not position: sticky or fixed, so it scrolls away")


# ---------- manifest.webmanifest and install icons ----------

MANIFEST = "manifest.webmanifest"
MANIFEST_FIELDS = ("name", "short_name", "start_url", "scope", "background_color", "theme_color")
REQUIRED_ICON_SIZES = ("192x192", "512x512")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def is_relative(path):
    return bool(path) and not (REMOTE_URL.match(path) or path.startswith("/") or ":" in path.split("/")[0])


def png_size(path):
    """(width, height) from a PNG's IHDR, or None when it is not a PNG."""
    head = path.read_bytes()[:24]
    if len(head) < 24 or not head.startswith(PNG_SIGNATURE) or head[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", head[16:24])


def check_icon_file(root, src, label):
    """Fail unless src is a relative path to a PNG under icons/; return its size."""
    if not is_relative(src) or not src.startswith("icons/"):
        fail(f"{label} {src!r} is not a relative path under icons/")
        return None
    path = root / src
    if not path.is_file():
        fail(f"{label} {src} does not exist")
        return None
    size = png_size(path)
    if size is None:
        fail(f"{label} {src} is not a PNG")
    return size


def check_manifest(root):
    path = root / MANIFEST
    if not path.is_file():
        fail(f"{MANIFEST} is missing at the repository root")
        return
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as err:
        fail(f"{MANIFEST} is not valid JSON: {err}")
        return
    if not isinstance(manifest, dict):
        fail(f"{MANIFEST} is not a JSON object")
        return
    for field in MANIFEST_FIELDS:
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            fail(f"{MANIFEST} has no {field}")
    for field in ("start_url", "scope"):
        if isinstance(manifest.get(field), str) and not is_relative(manifest[field]):
            fail(f"{MANIFEST} {field} {manifest[field]!r} is not relative, so a subpath host breaks it")
    if manifest.get("display") != "standalone":
        fail(f"{MANIFEST} display is {manifest.get('display')!r}, not \"standalone\"")

    icons = manifest.get("icons")
    if not isinstance(icons, list) or not icons:
        fail(f"{MANIFEST} has no icons array")
        return
    png_sizes = set()
    for icon in icons:
        src = icon.get("src", "") if isinstance(icon, dict) else ""
        claimed = icon.get("sizes", "") if isinstance(icon, dict) else ""
        size = check_icon_file(root, src, f"{MANIFEST} icon")
        if size is None:
            continue
        actual = f"{size[0]}x{size[1]}"
        if claimed != actual:
            fail(f"{MANIFEST} icon {src} claims sizes {claimed!r} but is {actual}")
        elif icon.get("type", "image/png") == "image/png":
            png_sizes.add(actual)
    for wanted in REQUIRED_ICON_SIZES:
        if wanted not in png_sizes:
            fail(f"{MANIFEST} lists no {wanted} PNG icon")


def check_install_tags(root):
    index = root / "index.html"
    if not index.is_file():
        return
    parser = ShellParser()
    parser.feed(index.read_text(encoding="utf-8"))

    def hrefs(rel):
        return [href for rels, href in parser.links if rel in rels]

    manifests = hrefs("manifest")
    if not manifests:
        fail(f'index.html has no <link rel="manifest" href="{MANIFEST}">')
    for href in manifests:
        if href != MANIFEST:
            fail(f'index.html links manifest {href!r}; expected the relative path "{MANIFEST}"')
    if not any(c.strip() for c in parser.theme_colors):
        fail('index.html has no <meta name="theme-color" content="...">')
    touch_icons = hrefs("apple-touch-icon")
    if not touch_icons:
        fail('index.html has no <link rel="apple-touch-icon"> pointing under icons/')
    for href in touch_icons:
        check_icon_file(root, href, "index.html apple-touch-icon")


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


def script_files(root):
    js_dir = root / "js"
    return sorted(p for p in js_dir.rglob("*.js") if p.is_file()) if js_dir.is_dir() else []


def install_files(root):
    return [p for p in (root / MANIFEST, root / "scripts" / "make_icons.py") if p.is_file()]


def check_remote_refs(root):
    for path in shell_files(root) + script_files(root) + install_files(root):
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
    check_manifest(root)
    check_install_tags(root)
    check_remote_refs(root)
    total = check_size(root)

    if failures:
        print(f"Static shell check FAILED ({len(failures)} problem(s)):")
        for message in failures:
            print(f"  - {message}")
        return 1
    print(f"Static shell check passed: {len(tokens)} tokens, 4 controls styled, manifest and install icons valid, no remote refs, {total} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
