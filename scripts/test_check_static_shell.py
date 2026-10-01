"""Regression tests for the sub-path guards in scripts/check_static_shell.py.

Each case copies the repository to a temporary directory, injects one
root-absolute path, runs the checker against the copy and expects exit 1
with a message naming the defect. The untouched tree must exit 0.

Usage: python3 -m unittest discover -s scripts -p "test_*.py"
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check_static_shell.py"


def load_checker():
    spec = importlib.util.spec_from_file_location("check_static_shell", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SubPathGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.tree = self.tmp / "tree"
        shutil.copytree(ROOT, self.tree, ignore=shutil.ignore_patterns(".git", "node_modules"))

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_checker(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.tree)],
            capture_output=True,
            text=True,
        )
        return result.returncode, result.stdout

    def inject(self, relpath, old, new):
        path = self.tree / relpath
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"fixture anchor missing from {relpath}")
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assert_fails(self, *expected):
        code, out = self.run_checker()
        self.assertEqual(code, 1, out)
        for message in expected:
            self.assertIn(message, out)

    def test_clean_tree_passes(self):
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)

    def test_root_absolute_stylesheet_href(self):
        self.inject("index.html", 'href="css/tokens.css"', 'href="/css/tokens.css"')
        self.assert_fails('<link href="/css/tokens.css"> is root-absolute')

    def test_root_absolute_script_src(self):
        self.inject("index.html", 'src="js/app.js"', 'src="/js/app.js"')
        self.assert_fails('<script src="/js/app.js"> is root-absolute')

    def test_root_absolute_manifest_link(self):
        self.inject("index.html", 'href="manifest.webmanifest"', 'href="/manifest.webmanifest"')
        self.assert_fails('<link href="/manifest.webmanifest"> is root-absolute')

    def test_root_absolute_srcset_candidate(self):
        self.inject(
            "index.html",
            "<h1>Rupee Ledger</h1>",
            '<h1>Rupee Ledger</h1><img alt="" srcset="icons/icon-192.png 1x, /icons/icon-512.png 2x">',
        )
        self.assert_fails('<img srcset="/icons/icon-512.png"> is root-absolute')

    def test_root_start_url_and_scope(self):
        self.inject("manifest.webmanifest", '"start_url": "./"', '"start_url": "/"')
        self.inject("manifest.webmanifest", '"scope": "./"', '"scope": "/"')
        self.assert_fails("start_url is '/', not \"./\"", "scope is '/', not \"./\"")

    def test_root_absolute_manifest_icon(self):
        self.inject("manifest.webmanifest", '"src": "icons/icon-192.png"', '"src": "/icons/icon-192.png"')
        self.assert_fails("icon '/icons/icon-192.png' is not a relative path under icons/")

    def test_root_absolute_precache_entry(self):
        self.inject("sw.js", "  './index.html',", "  '/index.html',")
        self.assert_fails("ASSETS entry '/index.html' is root-absolute")

    def test_root_absolute_shell(self):
        self.inject("sw.js", "const SHELL = './index.html'", "const SHELL = '/index.html'")
        self.assert_fails("SHELL '/index.html' is root-absolute")

    def test_precache_entry_outside_scope(self):
        self.inject("sw.js", "  './css/tokens.css',", "  './../css/tokens.css',")
        self.assert_fails("ASSETS entry './../css/tokens.css' climbs out of the worker's scope")

    def test_root_register_and_scope(self):
        self.inject("js/sw-register.js", "register('./sw.js', { scope: './' })", "register('/sw.js', { scope: '/' })")
        self.assert_fails(
            "does not call register('./sw.js')",
            "registers '/sw.js', a root-absolute worker URL",
            "passes scope '/'",
        )

    def test_commented_out_root_register_is_ignored(self):
        self.inject("js/sw-register.js", "    return true;", "    return true;//register('/sw.js', { scope: '/' })")
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)


class StripJsCommentsTest(unittest.TestCase):
    def setUp(self):
        self.strip = load_checker().strip_js_comments

    def test_drops_comment_straight_after_code(self):
        self.assertEqual(self.strip("foo();//register('/sw.js')"), "foo();")

    def test_keeps_double_slash_inside_strings(self):
        js = "const a = ' //x'; const b = \"a // b\"; const c = `//c`;"
        self.assertEqual(self.strip(js), js)

    def test_drops_block_comments_and_keeps_escaped_quotes(self):
        self.assertEqual(self.strip("a /* '/x' */ 'it\\'s' // tail"), "a   'it\\'s' ")


if __name__ == "__main__":
    unittest.main()
