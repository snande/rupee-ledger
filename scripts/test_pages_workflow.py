"""Regression tests for the shape of .github/workflows/pages.yml (#156).

On 79786b4 the single `deploy` job uploaded the Pages artifact and then
tried to deploy it in the same job. actions/deploy-pages found
"0 artifact(s)" and failed, and it failed again when re-run. The fix
splits the work in two: a `build` job uploads the artifact and a
`deploy` job that `needs: build` publishes it. These tests check that
layout with the standard library only (no PyYAML), so the layout cannot
quietly go back to one job.

Usage: python3 -m unittest discover -s scripts -p "test_*.py"
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"


def strip_comment(line):
    """Drop a trailing YAML comment. Good enough for this file, which never
    puts a `#` inside a quoted value."""
    return line.split("#", 1)[0].rstrip()


def jobs_by_name(text):
    """Return {job_name: job_body_text} for the top-level `jobs:` mapping.

    A job starts at a line indented exactly two spaces under `jobs:` and
    runs until the next such line or the next top-level key.
    """
    jobs = {}
    in_jobs = False
    current = None
    for raw in text.splitlines():
        line = strip_comment(raw)
        if not line.strip():
            if current is not None:
                jobs[current].append(raw)
            continue
        if not line.startswith(" "):
            in_jobs = line == "jobs:"
            current = None
            continue
        if not in_jobs:
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            current = match.group(1)
            jobs[current] = []
            continue
        if current is not None:
            jobs[current].append(raw)
    return {name: "\n".join(strip_comment(l) for l in body) for name, body in jobs.items()}


def action_major(body, action):
    """Major versions of every `uses: actions/<action>@vN` in body."""
    return [int(v) for v in re.findall(r"uses:\s*actions/%s@v(\d+)" % re.escape(action), body)]


class PagesWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.jobs = jobs_by_name(cls.text)

    def test_has_separate_build_and_deploy_jobs(self):
        self.assertIn("build", self.jobs, "pages.yml must have a `build` job that uploads the artifact")
        self.assertIn("deploy", self.jobs, "pages.yml must keep a job named `deploy`, the reported check name")

    def test_deploy_waits_for_build(self):
        deploy = self.jobs["deploy"]
        needs = re.search(r"^\s+needs:\s*(.+)$", deploy, re.MULTILINE)
        self.assertIsNotNone(needs, "the deploy job must declare `needs: build`")
        self.assertIn("build", re.findall(r"[A-Za-z0-9_-]+", needs.group(1)))

    def test_upload_only_in_build_and_at_least_v4(self):
        self.assertEqual(action_major(self.jobs["deploy"], "upload-pages-artifact"), [],
                         "the artifact must not be uploaded in the deploy job")
        versions = action_major(self.jobs["build"], "upload-pages-artifact")
        self.assertEqual(len(versions), 1, "the build job must upload the Pages artifact exactly once")
        self.assertGreaterEqual(versions[0], 4)

    def test_deploy_pages_only_in_deploy(self):
        self.assertEqual(action_major(self.jobs["build"], "deploy-pages"), [],
                         "the build job must not deploy")
        self.assertEqual(len(action_major(self.jobs["deploy"], "deploy-pages")), 1)

    def test_deploy_job_keeps_pages_environment(self):
        deploy = self.jobs["deploy"]
        self.assertRegex(deploy, r"name:\s*github-pages")
        self.assertIn("steps.deployment.outputs.page_url", deploy)
        self.assertRegex(deploy, r"id:\s*deployment")

    def test_pages_permissions_still_granted(self):
        self.assertRegex(self.text, r"(?m)^\s+pages:\s*write\s*$")
        self.assertRegex(self.text, r"(?m)^\s+id-token:\s*write\s*$")

    def test_site_is_still_the_repository_root_as_is(self):
        self.assertRegex(self.jobs["build"], r"(?m)^\s+path:\s*\.\s*$")


if __name__ == "__main__":
    unittest.main()
