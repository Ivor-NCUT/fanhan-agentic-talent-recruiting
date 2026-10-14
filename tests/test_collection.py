import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
SKILLS = ROOT / "skills"


class CollectionTest(unittest.TestCase):
    def test_manifest_discovers_each_skill_once(self):
        manifest = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
        paths = [ROOT / path for path in manifest["skills"]]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(set(paths), set(SKILLS.iterdir()))
        for path in paths:
            text = (path / "SKILL.md").read_text()
            name = re.search(r"^name: (.+)$", text, re.MULTILINE)
            self.assertIsNotNone(name)
            self.assertEqual(name.group(1), path.name)
            self.assertTrue((path / "agents/openai.yaml").is_file())

    def test_local_skill_links_resolve(self):
        for skill in SKILLS.glob("*/SKILL.md"):
            for target in re.findall(r"\]\(([^)]+)\)", skill.read_text()):
                if not target.startswith(("https://", "http://", "#")):
                    self.assertTrue((skill.parent / target).resolve().is_file(), target)

    def test_original_batch_command_matches_moved_implementation(self):
        data = {
            "direction": "job_to_candidates",
            "candidates": [{"id": "demo-c", "role_categories": ["研发"], "engagement": "全职", "resume_json": {"skills": ["Python"]}}],
            "jobs": [{"id": "demo-j", "title": "Python后端工程师", "role_categories": ["研发"], "attributes": {"type": "全职"}}],
        }
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            source = folder / "input.json"
            source.write_text(json.dumps(data, ensure_ascii=False))
            scripts = [ROOT / "scripts/run_match.py", SKILLS / "job-resume-intelligent-matching-fanhan/scripts/run_match.py"]
            results = []
            for index, script in enumerate(scripts):
                output = folder / f"output-{index}.json"
                subprocess.run([sys.executable, str(script), "--input", str(source), "--output", str(output)], check=True)
                results.append(json.loads(output.read_text()))
            self.assertEqual(results[0], results[1])
            self.assertEqual(results[0]["matches"][0]["candidate_id"], "demo-c")


if __name__ == "__main__":
    unittest.main()
