import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from unittest.mock import patch


def no_network(*args, **kwargs):
    raise AssertionError("provider controls must not use the network")


socket.socket.connect = no_network
socket.create_connection = no_network
output = Path(__file__).with_name("providers.json")
reference = Path(sys.argv[1]).resolve()
reference_commit = subprocess.check_output(["git", "-C", str(reference), "rev-parse", "HEAD"], text=True).strip()
assert reference_commit == "04d809ceab9df28f9adaed044884180159172930"
with tempfile.TemporaryDirectory(prefix="lean-provider-source-") as home:
    os.environ.clear()
    os.environ.update({"PATH": os.defpath, "HOME": home, "TMPDIR": home,
                       "LITELLM_LOCAL_MODEL_COST_MAP": "true", "PYTHON_DOTENV_DISABLED": "1",
                       "OPENROUTER_API_KEY": "source-fake-key", "REQUESTY_API_KEY": "source-fake-key"})
    os.chdir(home)
    sys.path.insert(0, str(reference / "src"))
    import httpx
    import litellm
    import requests
    from litellm.llms.custom_httpx.http_handler import HTTPHandler
    from minisweagent.models import openrouter_model, requesty_model, portkey_model
    from minisweagent.exceptions import FormatError
    assert importlib.metadata.version("litellm") == "1.108.3"
    cases = []
    model = "anthropic.claude-3-haiku-20240307-v1:0"
    usage = {"inputTokens": 100, "outputTokens": 20, "totalTokens": 150,
             "cacheReadInputTokens": 10, "cacheWriteInputTokens": 20}
    contents = [
        ("text", [{"text": "hello"}, {"text": " world"}], "end_turn"),
        ("tool", [{"text": "running"}, {"toolUse": {"toolUseId": "call_1", "name": "bash", "input": {"command": "echo café", "nested": {"x": 1}}}}], "tool_use"),
        ("length", [{"text": "partial"}], "max_tokens"),
        ("empty", [], "stop_sequence"),
        ("uncached", [{"text": "hello"}], "end_turn"),
        ("missing total", [{"text": "hello"}], "end_turn"),
    ]
    for name, content, stop in contents:
        body = {"output": {"message": {"role": "assistant", "content": content}},
                "stopReason": stop, "usage": copy.deepcopy(usage), "metrics": {"latencyMs": 1}}
        if name == "uncached":
            body["usage"] = {"inputTokens": 100, "outputTokens": 20, "totalTokens": 120}
        if name == "missing total":
            del body["usage"]["totalTokens"]
        sent = []
        def bedrock_post(self, url, **kwargs):
            sent.append({"url": url, "body": json.loads(kwargs["data"])})
            return httpx.Response(200, json=body, request=httpx.Request("POST", url))
        with patch.object(HTTPHandler, "post", bedrock_post), patch("time.time", return_value=1234):
            result = litellm.completion(
                model="bedrock/" + model, messages=[{"role": "user", "content": "task"}],
                api_base="https://fixture.invalid", aws_access_key_id="source-fake-key",
                aws_secret_access_key="source-fake-secret", aws_region_name="us-east-1")
        dumped = result.model_dump()
        assert dumped["id"].startswith("chatcmpl-")
        dumped["id"] = "source-id"
        cases.append({"name": "bedrock " + name, "body": body, "request": sent[0], "response": dumped})
    for provider, module, cls in [("openrouter", openrouter_model, openrouter_model.OpenRouterModel),
                                  ("requesty", requesty_model, requesty_model.RequestyModel)]:
        response = {"id": "raw-id", "model": "returned-model", "choices": [{"finish_reason": "tool_calls", "message": {
            "role": "assistant", "content": None, "provider_extra": "kept", "tool_calls": [
                {"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": '{"command":"echo hi"}'}}]}}],
            "usage": {"cost": 0.125, "prompt_tokens": 7}, "extra": {"raw": True}}
        messages = [{"role": "user", "content": "task", "extra": {"private": True}}]
        instance = cls(model_name="openai/gpt-4o", model_kwargs={"temperature": 0.3, "api_key": "body-key"})
        sent = []
        def post(url, **kwargs):
            sent.append({"url": url, "headers": kwargs["headers"], "body": json.loads(kwargs["data"]), "timeout": kwargs["timeout"]})
            raw = requests.Response()
            raw.status_code = 200
            raw._content = json.dumps(response).encode()
            return raw
        with patch.object(module.requests, "post", side_effect=post), patch("time.time", return_value=1234):
            result = instance.query(copy.deepcopy(messages), temperature=0.8)
        cases.append({"name": provider + " query", "messages": messages, "response": response,
                      "request": sent[0], "result": result, "config": instance.get_template_vars()})
        for cost in (0, -0.25):
            raw = {"usage": {"cost": cost}}
            row = {"name": provider + " cost " + str(cost), "response": raw}
            try:
                row["cost"] = instance._calculate_cost(raw)["cost"]
            except Exception as error:
                row["error"] = {"name": type(error).__name__, "message": str(error)}
            cases.append(row)
        try:
            missing_cost = instance._calculate_cost({})
        except Exception as error:
            cases.append({"name": provider + " missing cost", "response": {}, "error": {"name": type(error).__name__, "message": str(error)}})
        if provider == "openrouter":
            ignored = cls(model_name="openai/gpt-4o", cost_tracking="ignore_errors")
            cases.append({"name": "openrouter ignored cost", "response": {"usage": {"cost": -0.25}},
                          "cost": ignored._calculate_cost({"usage": {"cost": -0.25}})["cost"]})
        for status in (401, 429, 500):
            def failed_post(*args, **kwargs):
                raw = requests.Response()
                raw.status_code = status
                raw._content = b"provider failure"
                return raw
            with patch.object(module.requests, "post", side_effect=failed_post):
                try:
                    instance._query([])
                except Exception as error:
                    cases.append({"name": provider + " status " + str(status), "status": status,
                                  "error": {"name": type(error).__name__, "message": str(error)}})
        bad = copy.deepcopy(response)
        bad["choices"][0]["message"]["tool_calls"] = []
        def bad_post(*args, **kwargs):
            raw = requests.Response()
            raw.status_code = 200
            raw._content = json.dumps(bad).encode()
            return raw
        with patch.object(module.requests, "post", side_effect=bad_post):
            try:
                instance.query(messages)
            except FormatError as error:
                cases.append({"name": provider + " format error", "response": bad, "messages": error.messages})
    real_portkey = portkey_model.Portkey
    portkey_response = {"id": "portkey-id", "object": "chat.completion", "created": 1234, "model": "gpt-4o",
                        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                        "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": '{"command":"echo hi"}'}}]}}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13}}
    portkey_sent = []
    def portkey_send(request):
        portkey_sent.append({"url": str(request.url), "headers": dict(request.headers), "body": json.loads(request.content)})
        return httpx.Response(200, json=portkey_response)
    def portkey_client(**kwargs):
        return real_portkey(**kwargs, http_client=httpx.Client(transport=httpx.MockTransport(portkey_send)))
    with patch.dict(os.environ, {"PORTKEY_API_KEY": "source-fake-key"}), patch.object(portkey_model, "Portkey", side_effect=portkey_client), patch("time.time", return_value=1234):
        instance = portkey_model.PortkeyModel(model_name="gpt-4o", provider="openai")
        result = instance.query([{"role": "user", "content": "task"}])
        cases.append({"name": "portkey query research", "response": portkey_response, "request": portkey_sent[0], "result": result})
    try:
        portkey_model.PortkeyModel(model_name="gpt-4o")
    except Exception as error:
        cases.append({"name": "portkey missing key", "error": {"name": type(error).__name__, "message": str(error)}})
    paths = [Path(openrouter_model.__file__), Path(requesty_model.__file__), Path(portkey_model.__file__)]
    import litellm.llms.bedrock.chat.converse_transformation as converse
    paths.append(Path(converse.__file__))
    output.write_text(json.dumps({"reference_commit": reference_commit,
                                  "bedrock_id_normalization": "Generated UUID replaced with source-id. time.time fixed at 1234.",
                                  "litellm": importlib.metadata.version("litellm"),
                                  "portkey_ai": importlib.metadata.version("portkey-ai"),
                                  "source_hashes": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
                                  "cases": cases}, indent=2) + "\n")
