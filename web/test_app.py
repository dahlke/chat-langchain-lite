import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient


class RevisionMetadataTests(unittest.IsolatedAsyncioTestCase):
    def load_app(self, revision, git_result="baseline-52-gb8022bf\n", git_error=None):
        env = {"SESSION_SECRET": "test-session-secret"}
        if revision is not None:
            env["LANGSMITH_REVISION_ID"] = revision
        spec = importlib.util.spec_from_file_location(
            "web.app", Path(__file__).with_name("app.py")
        )
        module = importlib.util.module_from_spec(spec)
        with (
            patch.dict(os.environ, env, clear=True),
            patch("dotenv.load_dotenv"),
            patch(
                "subprocess.check_output", return_value=git_result, side_effect=git_error
            ) as git,
        ):
            spec.loader.exec_module(module)
        return module, git

    async def created_metadata(self, module):
        create = AsyncMock(return_value={"run_id": "12345678-1234-1234-1234-123456789abc"})
        client = SimpleNamespace(runs=SimpleNamespace(create=create))
        with patch.object(module, "get_client", return_value=client):
            with TestClient(module.app) as browser:
                response = browser.post("/send", data={"q": "What is LangGraph?"})
            self.assertEqual(response.status_code, 200)
        create.assert_awaited_once()
        return create.call_args.kwargs["metadata"]

    async def test_environment_revision_takes_precedence(self):
        module, git = self.load_app("release-from-environment")
        self.assertEqual(
            await self.created_metadata(module),
            {
                "demo": "true",
                "demo_type": "chat-lc-lite",
                "revision_id": "release-from-environment",
            },
        )
        git.assert_not_called()

    async def test_git_fallback_is_reused_across_runs(self):
        module, git = self.load_app(None)
        for _ in range(2):
            self.assertEqual(
                await self.created_metadata(module),
                {
                    "demo": "true",
                    "demo_type": "chat-lc-lite",
                    "revision_id": "baseline-52-gb8022bf",
                },
            )
        git.assert_called_once_with(
            ["git", "describe", "--tags", "--always"],
            cwd=Path(__file__).resolve().parent.parent,
            text=True,
            stderr=subprocess.DEVNULL,
        )

    async def test_no_revision_when_git_is_unavailable_or_fails(self):
        for error in (FileNotFoundError(), subprocess.CalledProcessError(128, "git")):
            with self.subTest(error=type(error).__name__):
                module, _ = self.load_app(None, git_error=error)
                self.assertEqual(
                    await self.created_metadata(module),
                    {"demo": "true", "demo_type": "chat-lc-lite"},
                )

    async def test_empty_git_output_omits_revision(self):
        module, _ = self.load_app(None, git_result="\n")
        self.assertEqual(
            await self.created_metadata(module),
            {"demo": "true", "demo_type": "chat-lc-lite"},
        )
