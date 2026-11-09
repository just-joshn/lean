import copy
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import tempfile


def no_network(*args, **kwargs):
    raise AssertionError("source controls must not use the network")


socket.socket.connect = no_network
socket.create_connection = no_network
output = Path(__file__).with_name("responses-request.json")
with tempfile.TemporaryDirectory(prefix="lean-responses-request-source-") as home:
    os.environ.clear()
    os.environ.update({"PATH": os.defpath, "HOME": home, "TMPDIR": home,
                       "LITELLM_LOCAL_MODEL_COST_MAP": "true", "PYTHON_DOTENV_DISABLED": "1"})
    os.chdir(home)
    import litellm
    from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
    from litellm.responses.utils import ResponsesAPIRequestUtils
    from litellm.types.router import GenericLiteLLMParams
    from litellm.utils import get_optional_params

    assert importlib.metadata.version("litellm") == "1.108.3"
    config = OpenAIResponsesAPIConfig()
    cases = []

    def capture(name, model="gpt-4o", input=None, tools=None, kwargs=None):
        options = {"model": "openai/" + model,
                   "input": copy.deepcopy(input if input is not None else [{"role": "user", "content": "task"}]),
                   "modelKwargs": copy.deepcopy(kwargs or {})}
        if tools is not None:
            options["tools"] = copy.deepcopy(tools)
        row = {"name": name, "options": options}
        params = copy.deepcopy(kwargs or {})
        host = params.pop("api_base", None)
        drop = params.pop("drop_params", False)
        model_info = params.pop("model_info", None)
        if tools is not None:
            params["tools"] = copy.deepcopy(tools)
        try:
            mapped = ResponsesAPIRequestUtils.get_optional_params_responses_api(
                model=model, responses_api_provider_config=config,
                response_api_optional_params=params, drop_params=drop)
            row["body"] = config.transform_responses_api_request(
                model=model, input=copy.deepcopy(options["input"]),
                response_api_optional_request_params=mapped,
                litellm_params=GenericLiteLLMParams(api_base=host, model_info=model_info), headers={})
        except litellm.UnsupportedParamsError as error:
            row["error"] = {"name": type(error).__name__, "message": error.message}
        cases.append(row)

    capture("unmarked input")
    for model in ("gpt-5", "gpt-5-chat-latest", "gpt-5.1", "gpt-5.2", "gpt-5.5", "gpt-5.6", "gpt-6"):
        for param, value in (("temperature", 0), ("temperature", 1), ("top_p", 0.5), ("top_p", 1)):
            for drop in (False, True):
                capture(f"{model} {param}={value} drop={drop}", model=model,
                        kwargs={param: value, "drop_params": drop})
        for effort in ("none", "low"):
            for drop in (False, True):
                capture(f"{model} explicit {effort} sampling drop={drop}", model=model,
                        kwargs={"temperature": 0, "top_p": 0.5, "reasoning": {"effort": effort}, "drop_params": drop})
    capture("non-gpt-5 sampling", kwargs={"temperature": 0, "top_p": 0.5})
    for value in (-1, 0, 1, 15, 16, 17, 1.5, "1", True, False):
        capture(f"max_output_tokens={value!r}", kwargs={"max_output_tokens": value})
    for drop in (False, True):
        capture(f"unsupported reasoning drop={drop}", kwargs={"reasoning": {"effort": "low"}, "drop_params": drop})

    mark = {"type": "ephemeral"}
    cache_input = [
        {"role": role, "content": [{"type": "input_text", "text": role, "cache_control": mark},
                                   {"type": "input_image", "image_url": "https://image.test/a", "cache_control": mark}]}
        for role in ("system", "developer", "user", "assistant")
    ] + [{"type": "function_call_output", "call_id": "call_1", "output": "done", "cache_control": mark},
         {"role": "user", "content": "last", "cache_control": mark}]
    tools = [{"type": "function", "name": "bash", "cache_control": mark,
              "parameters": {"type": "object", "properties": {"command": {"type": "string", "cache_control": mark}}}}]
    for model in ("gpt-4o", "gpt-5.5", "gpt-5.6"):
        for host in (None, "https://api.openai.com/v1", "https://proxy.test/v1"):
            for opt in (False, True):
                kwargs = {"api_base": host} if host else {}
                if opt:
                    kwargs["prompt_cache_options"] = {"mode": "explicit"}
                capture(f"cache {model} host={host} opt={opt}", model=model, input=cache_input, tools=tools, kwargs=kwargs)
    capture("existing breakpoint and last readable part", model="gpt-5.6", input=[{
        "role": "user", "cache_control": mark, "content": [
            {"type": "input_text", "text": "first", "cache_control": mark, "prompt_cache_breakpoint": {"mode": "existing"}},
            {"type": "input_file", "file_id": "file_1"}, {"type": "other", "cache_control": mark}]}])

    for kind in ("allOf", "anyOf", "oneOf"):
        schema = {"type": "object", "properties": {"root": {"type": "string"}}, "required": ["root"], kind: [
            {"type": "object", "properties": {"a": {"type": "string"}, "shared": {"type": "string"}}, "required": ["a", "shared"]},
            {"type": "object", "properties": {"b": {"type": "number"}, "shared": {"type": "number"}}, "required": ["b", "shared"]}]}
        for model in ("gpt-4o", "gpt-5"):
            capture(f"schema {kind} {model}", model=model, tools=[{"type": "function", "name": "f", "parameters": schema}])
    capture("nested property combinator stays", tools=[{"type": "function", "name": "f", "parameters": {
        "type": "object", "properties": {"value": {"anyOf": [{"type": "string"}, {"type": "null"}]}}}}])
    capture("non-object combinator stays", tools=[{"type": "function", "name": "f", "parameters": {"anyOf": [{"type": "string"}, {"type": "number"}]}}])
    capture("namespace combinator", tools=[{"type": "namespace", "name": "ns", "tools": [
        {"type": "function", "name": "f", "parameters": schema}]}])
    for kind, prefix in (("function_call", "fc"), ("custom_tool_call", "ctc"), ("tool_search_call", "tsc"), ("message", "msg")):
        for identifier in ("foreign_1", prefix + "_1", prefix + "bare", None, 7):
            capture(f"identifier {kind} {identifier!r}", input=[{"type": kind, "id": identifier, "call_id": "call_kept", "name": "bash", "arguments": "{}"}])

    returns = json.loads(output.with_name("responses-return.json").read_text())
    for fixture in returns["cases"]:
        if fixture["name"] not in ("function and reasoning", "tool search validated", "tool search constructed"):
            continue
        replay = [{k: v for k, v in item.items() if k != "extra"}
                  for item in fixture["dump"]["output"] if item.get("type") != "function_call"]
        command = {"type": "function_call", "call_id": "command", "name": "bash",
                   "arguments": '{"command":"pwd"}', "metadata": {"retained": True}}
        if fixture["name"] != "tool search constructed":
            command.update({"id": None, "async_": None, "caller": None, "namespace": None, "status": None})
        replay.append(command)
        capture("return replay " + fixture["name"], input=replay)

    frequency = []
    for provider, model in (("anthropic", "claude-sonnet-4-5-20250929"), ("openai", "gpt-4o")):
        for drop in (False, True):
            row = {"provider": provider, "model": model, "drop": drop}
            try:
                row["params"] = get_optional_params(model=model, custom_llm_provider=provider,
                                                    frequency_penalty=0.5, drop_params=drop)
            except litellm.UnsupportedParamsError as error:
                row["error"] = {"name": type(error).__name__, "message": error.message}
            frequency.append(row)
    source = Path(litellm.__file__).parent
    paths = ["llms/openai/responses/transformation.py", "llms/openai/chat/gpt_5_transformation.py",
             "litellm_core_utils/prompt_templates/common_utils.py", "integrations/anthropic_cache_control_hook.py",
             "responses/litellm_completion_transformation/custom_tools.py", "responses/utils.py",
             "model_prices_and_context_window_backup.json"]
    output.write_text(json.dumps({"litellm": "1.108.3", "method": "Pure source optional-parameter mapping and request transform; socket connections forbidden.",
                                  "source_sha256": {p: hashlib.sha256((source / p).read_bytes()).hexdigest() for p in paths},
                                  "cases": cases, "frequency": frequency,
                                  "gates": ["Non-OpenAI Responses providers", "Schema local/external/cyclic refs and recursive combinators", "Schema enum/const/not, fine-tuned names, and model_info.base_model", "Python-regex schema sanitation", "String-encoded tool schemas and invalid parameter types", "Tool-search mapping and defer_loading", "Reasoning-item replay conversion and bridge-minted removal", "Catalog overrides and hosted-provider cache breakpoints", "Other reasoning-effort levels and catalog overrides", "Streaming and remaining response serialization"]}, indent=2) + "\n")
    print(f"saved {len(cases)} request controls and {len(frequency)} frequency controls to {output}")
