import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from langchain_anthropic import ChatAnthropic
from langchain_core.load import load
from scripts import run_evals, setup


class OnlineEvaluatorTests(unittest.TestCase):
    def test_registration_uses_gateway_workspace_secret(self):
        client = Mock()
        client.list_projects.return_value = [
            SimpleNamespace(name=setup.PROJECT_NAME, id="project-id")
        ]
        response = Mock(status_code=201)
        response.json.return_value = {"id": "rule-id"}
        with (
            patch.dict(
                "os.environ",
                {
                    "LANGSMITH_API_KEY": "local-api-key",
                    "ANTHROPIC_API_KEY": "literal-provider-key",
                    "LANGSMITH_API_KEY_GATEWAY": "literal-gateway-key",
                },
            ),
            patch("langsmith.Client", return_value=client),
            patch.object(setup, "delete_existing_evaluators"),
            patch.object(setup, "smoke_test_online_evaluator"),
            patch("requests.post", return_value=response) as post,
        ):
            setup.setup_online_evaluators("local-api-key")
            run_evals.setup_online_eval()
        self.assertEqual(
            post.call_count, len(setup.EVALUATORS) + len(run_evals.ONLINE_EVALUATORS)
        )
        for call in post.call_args_list:
            model = call.kwargs["json"]["evaluators"][0]["structured"]["model"]
            self.assertEqual(
                model["kwargs"]["anthropic_api_url"],
                "https://gateway.smith.langchain.com/anthropic",
            )
            self.assertEqual(model["kwargs"]["model"], "claude-haiku-4-5-20251001")
            self.assertEqual(
                model["kwargs"]["anthropic_api_key"],
                {"lc": 1, "type": "secret", "id": ["LANGSMITH_API_KEY_GATEWAY"]},
            )
            self.assertNotIn("literal-provider-key", json.dumps(model))
            self.assertNotIn("literal-gateway-key", json.dumps(model))
            restored = load(
                model,
                allowed_objects=[ChatAnthropic],
                secrets_map={"LANGSMITH_API_KEY_GATEWAY": "resolved-workspace-key"},
            )
            self.assertEqual(
                restored.anthropic_api_key.get_secret_value(), "resolved-workspace-key"
            )

    def test_smoke_accepts_both_valid_scores_after_pending_feedback(self):
        for score in (0, 1):
            with self.subTest(score=score), patch.object(setup.time, "sleep"):
                client = Mock()
                client.list_feedback.side_effect = [
                    [],
                    [SimpleNamespace(score=score, comment=None, extra=None)],
                ]
                setup.smoke_test_online_evaluator(client, "project-id")
                run_id = client.create_run.call_args.kwargs["id"]
                self.assertEqual(
                    client.list_feedback.call_args.kwargs["run_ids"], [run_id]
                )

    def test_smoke_rejects_errored_and_invalid_feedback(self):
        for score, extra in ((None, {}), (1, {"error": True}), (2, {})):
            with self.subTest(score=score, extra=extra):
                client = Mock()
                client.list_feedback.return_value = [
                    SimpleNamespace(
                        score=score,
                        comment="Anthropic authentication failed",
                        extra=extra,
                    )
                ]
                with self.assertRaisesRegex(
                    RuntimeError, "Anthropic authentication failed"
                ):
                    setup.smoke_test_online_evaluator(client, "project-id")

    def test_smoke_times_out_without_feedback(self):
        client = Mock()
        client.list_feedback.return_value = []
        with (
            patch.object(setup.time, "sleep"),
            self.assertRaisesRegex(RuntimeError, "without scored feedback"),
        ):
            setup.smoke_test_online_evaluator(client, "project-id")

    def test_setup_propagates_smoke_failure(self):
        client = Mock()
        client.list_projects.return_value = [
            SimpleNamespace(name=setup.PROJECT_NAME, id="project-id")
        ]
        with (
            patch("langsmith.Client", return_value=client),
            patch.object(setup, "delete_existing_evaluators"),
            patch.object(setup, "create_online_evaluator", return_value="rule-id"),
            patch.object(
                setup,
                "smoke_test_online_evaluator",
                side_effect=RuntimeError("authentication failed"),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "authentication failed"):
                setup.setup_online_evaluators("local-api-key")

    def test_readme_identifies_hosted_secret_reference(self):
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text()
        secret = setup.online_evaluator_model()["kwargs"]["anthropic_api_key"]
        self.assertIn(json.dumps(secret), readme)
        self.assertIn("create the workspace secret `LANGSMITH_API_KEY_GATEWAY`", readme)
        self.assertIn("local environment variable alone does not provision", readme)


if __name__ == "__main__":
    unittest.main()
