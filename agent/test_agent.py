import importlib
import os
import unittest
from unittest.mock import patch

from anthropic.types import Message
from langchain.agents.middleware import AgentMiddleware
from langchain_core.callbacks import BaseCallbackHandler


class TraceModels(BaseCallbackHandler):
    def __init__(self):
        self.root_model = None
        self.child_model = None

    def on_chain_start(self, serialized, inputs, *, parent_run_id=None, **kwargs):
        if parent_run_id is None:
            self.root_model = kwargs["metadata"]["model"]

    def on_llm_end(self, response, **kwargs):
        self.child_model = response.llm_output["model_name"]


class ModelConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {
            "LANGSMITH_API_KEY_GATEWAY": "test-key",
            "LANGSMITH_TRACING": "false",
        }))
        os.environ.pop("CHAT_LANGCHAIN_LITE_MODEL", None)
        self.enterContext(patch("dotenv.load_dotenv"))
        self.enterContext(patch("context.get_prompt", return_value="Answer briefly."))

    def load_agent(self):
        import utils.models
        importlib.reload(utils.models)
        import agent.agent
        return importlib.reload(agent.agent)

    def check_model(self, expected):
        agent = self.load_agent()
        from utils.models import MODEL_CONFIG, model

        self.assertEqual(MODEL_CONFIG["model"], expected)
        self.assertEqual(agent._config()["metadata"]["model"], expected)
        self.assertEqual(model.model, expected)
        self.assertEqual(MODEL_CONFIG["provider"], "anthropic")
        self.assertEqual(MODEL_CONFIG["base_url"],
                         "https://gateway.smith.langchain.com/anthropic")
        self.assertEqual(str(model._client.base_url).rstrip("/"),
                         MODEL_CONFIG["base_url"])
        trace = TraceModels()
        response = Message.model_validate({
            "id": "msg_test", "type": "message", "role": "assistant",
            "model": expected, "content": [{"type": "text", "text": "Hello"}],
            "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 5, "output_tokens": 1},
        })
        with patch.object(model._client.messages, "create", return_value=response) as send:
            with patch.object(agent, "_readonly_context_hub_fs", return_value=AgentMiddleware()):
                config = agent._config()
                config["callbacks"] = [trace]
                result = agent.build_agent().invoke(agent._user_msg("Hello"), config)
        self.assertEqual(result["messages"][-1].content, "Hello")
        self.assertEqual(send.call_args.kwargs["model"], expected)
        self.assertEqual(trace.root_model, expected)
        self.assertEqual(trace.child_model, trace.root_model)

    def test_default_model(self):
        self.check_model("claude-haiku-4-5-20251001")

    def test_environment_override(self):
        os.environ["CHAT_LANGCHAIN_LITE_MODEL"] = "claude-sonnet-4-6"
        self.check_model("claude-sonnet-4-6")

    def test_empty_override_uses_default(self):
        os.environ["CHAT_LANGCHAIN_LITE_MODEL"] = ""
        self.check_model("claude-haiku-4-5-20251001")

    def test_trace_generation_selects_haiku(self):
        os.environ["CHAT_LANGCHAIN_LITE_MODEL"] = "claude-sonnet-4-6"
        import scripts.generate_traces
        importlib.reload(scripts.generate_traces)
        self.check_model("claude-haiku-4-5-20251001")


if __name__ == "__main__":
    unittest.main()
