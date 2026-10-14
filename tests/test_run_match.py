import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "run_match.py"
SPEC = importlib.util.spec_from_file_location("run_match", MODULE_PATH)
run_match = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = run_match
SPEC.loader.exec_module(run_match)


class CategoryGateTest(unittest.TestCase):
    def test_candidate_to_jobs_excludes_category_and_engagement_conflicts(self):
        result = run_match.run({
            "direction": "candidate_to_jobs",
            "candidates": [{"id": "c", "role_categories": ["研发"], "engagement": "正职", "resume_text": "Python后端"}],
            "jobs": [
                {"id": "intern", "title": "Python实习后端", "role_categories": ["研发"], "attributes": {"type": "实习"}},
                {"id": "other", "title": "Python增长运营", "role_categories": ["增长/运营/市场"], "attributes": {"type": "正职"}},
                {"id": "fit", "title": "Python后端", "role_categories": ["研发"], "attributes": {"type": "正职"}},
            ],
        })
        self.assertEqual([row["job_id"] for row in result["matches"]], ["fit"])

    def test_candidate_to_jobs_preserves_unknown_engagement_for_review(self):
        result = run_match.run({
            "direction": "candidate_to_jobs",
            "candidates": [{"id": "c", "role_categories": ["研发"], "resume_text": "Python后端"}],
            "jobs": [{"id": "j", "title": "Python后端", "role_categories": ["研发"], "attributes": {"type": "正职"}}],
        })
        self.assertEqual([row["job_id"] for row in result["matches"]], ["j"])
        self.assertEqual(result["matches"][0]["compatibility"], "risk")

    def test_candidate_to_jobs_does_not_empty_pool_on_missing_category(self):
        result = run_match.run({
            "direction": "candidate_to_jobs",
            "candidates": [{"id": "c", "engagement": "正职", "resume_text": "Python后端"}],
            "jobs": [{"id": "j", "title": "Python后端", "role_categories": ["研发"], "attributes": {"type": "正职"}}],
        })
        self.assertEqual([row["job_id"] for row in result["matches"]], ["j"])
        self.assertTrue(any("类目" in reason for reason in result["matches"][0]["risk_reason"]))

    def test_job_to_candidates_ranks_only_complete_same_category_json(self):
        data = {
            "direction": "job_to_candidates",
            "jobs": [{"id": "j1", "title": "算法工程师", "description": "LLM RAG Python", "attributes": {"type": "全职"}}],
            "candidates": [
                {"id": "a", "name": "算法一", "候选人职位类目": ["算法"], "实习 & 正职": "正职", "候选人检索字段 JSON.文本": '{"skills":"LLM RAG Python"}'},
                {"id": "b", "name": "算法二", "候选人职位类目": ["算法"], "实习 & 正职": "正职", "resume_json": "not-json"},
                {"id": "c", "name": "研发一", "候选人职位类目": ["研发"], "实习 & 正职": "正职", "resume_json": {"skills": "LLM RAG Python"}},
            ],
        }

        result = run_match.run(data)

        self.assertEqual([row["candidate_id"] for row in result["matches"]], ["a"])
        self.assertEqual(result["pool_audit"][0]["job_categories"], ["算法"])
        self.assertEqual(result["pool_audit"][0]["category_rows"], 2)
        self.assertEqual(result["pool_audit"][0]["json_excluded_rows"], 1)


if __name__ == "__main__":
    unittest.main()
