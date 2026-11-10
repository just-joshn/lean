import copy
import json
import os
import tempfile
from pathlib import Path
from typing import get_args, get_origin, get_type_hints
from collections.abc import Iterable
from typing_extensions import is_typeddict
from importlib.metadata import version

root = Path(__file__).resolve().parent
home = tempfile.TemporaryDirectory(prefix="lean-serialization-source-")
os.environ.clear()
os.environ.update(HOME=home.name, PATH=os.defpath, LITELLM_LOCAL_MODEL_COST_MAP="true", MSWEA_SILENT_STARTUP="1", PYTHON_DOTENV_DISABLED="1")
os.chdir(home.name)
import httpx
from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
from litellm.types.llms.openai import ResponsesAPIResponse
assert version("litellm") == "1.108.3"

class Logger:
    def post_call(self, **kwargs):
        pass

def transform(body):
    raw = httpx.Response(200, json=body, request=httpx.Request("POST", "http://unused.invalid/responses"))
    return OpenAIResponsesAPIConfig().transform_response_api_response(model="gpt-4o", raw_response=raw, logging_obj=Logger())

records = set()
visited = set()
def inspect_type(annotation):
    if annotation in visited:
        return
    visited.add(annotation)
    if is_typeddict(annotation):
        records.add(annotation.__name__)
        for value in get_type_hints(annotation, include_extras=True).values():
            inspect_type(value)
    elif isinstance(annotation, type) and hasattr(annotation, "model_fields"):
        for field in annotation.model_fields.values():
            inspect_type(field.annotation)
    for arg in get_args(annotation):
        try:
            inspect_type(arg)
        except TypeError:
            pass
inspect_type(ResponsesAPIResponse)
schema = ResponsesAPIResponse.model_json_schema()
defs = schema["$defs"]
def resolve(s):
    return defs[s["$ref"].rsplit("/", 1)[1]] if "$ref" in s else s

def sample(s, depth=0, full=False):
    s = resolve(s)
    if depth > 20:
        return {}
    if "const" in s:
        return s["const"]
    if "enum" in s:
        return s["enum"][0]
    if "anyOf" in s:
        return sample(next(x for x in s["anyOf"] if x.get("type") != "null"), depth + 1, full)
    if "oneOf" in s:
        return sample(s["oneOf"][0], depth + 1, full)
    t = s.get("type")
    if t == "object":
        return {k: sample(v, depth + 1, full) for k, v in s.get("properties", {}).items() if full or k in s.get("required", [])}
    if t == "array":
        return [sample(s["items"], depth + 1, full)] if full else []
    if t == "string":
        return "owned"
    if t in ("integer", "number"):
        return 1
    if t == "boolean":
        return True
    return {}

base = dict(id="owned-response", created_at=1, object="response", model="gpt-4o", output=[])
cases = []
def record(name, body):
    response = transform(copy.deepcopy(body))
    dumped = response.model_dump()
    json_dump = response.model_dump(mode="json")
    for mode in ("python", "other"):
        assert response.model_dump(mode=mode) == dumped, (name, mode, repr(dumped), repr(response.model_dump(mode=mode)))
    cases.append(dict(name=name, body=body, dump=dumped, **({"json_dump": json_dump} if json_dump != dumped else {}), live_fields={field: type(getattr(response, field)).__name__ for field in ("tool_choice", "text", "incomplete_details")}, live_types=[type(x).__name__ for x in response.output] if isinstance(response.output, list) else None))

output = schema["properties"]["output"]["anyOf"][0]["items"]["anyOf"]
for choice in output:
    if "$ref" not in choice:
        continue
    item = sample(choice)
    name = item["type"]
    record(name, {**base, "output": [item]})
    record(name + " populated nested fields", {**base, "output": [sample(choice, full=True)]})
    record(name + " invalid required type", {**base, "output": [{**item, next(k for k in item if k != "type"): 17}]})
    record(name + " missing required", {**base, "output": [{k: v for k, v in item.items() if k != next(k for k in item if k != "type")}]})

for name in ["AnnotationFileCitation", "AnnotationURLCitation", "AnnotationContainerFileCitation", "AnnotationFilePath"]:
    annotation = sample({"$ref": "#/$defs/" + name})
    for field in ("index", "start_index", "end_index"):
        if field in annotation:
            annotation[field] = "2"
    text = dict(type="output_text", text="é雪", annotations=[annotation], logprobs=[dict(token="é", bytes=["195", 169], logprob="-0.5", top_logprobs=[dict(token="e", bytes=[101], logprob="-1")])])
    message = dict(type="message", id="message", role="assistant", status="completed", content=[text])
    record(name + " and logprobs coerce", {**base, "output": [message]})
    exact = copy.deepcopy(message)
    for field in ("index", "start_index", "end_index"):
        if field in exact["content"][0]["annotations"][0]:
            exact["content"][0]["annotations"][0][field] = 2
    exact["content"][0]["logprobs"][0].update(bytes=[195, 169], logprob=-0.5, top_logprobs=[dict(token="e", bytes=[101], logprob=-1.0)])
    record(name + " exact nonempty models", {**base, "output": [exact]})
    bad = copy.deepcopy(message)
    bad["content"][0]["annotations"][0].pop("type")
    record(name + " invalid annotation", {**base, "output": [bad]})
    bad = copy.deepcopy(message)
    bad["content"][0]["logprobs"][0].pop("token")
    record(name + " invalid logprob", {**base, "output": [bad]})

for choice in schema["properties"]["tools"]["anyOf"][0]["items"]["anyOf"]:
    tool = sample(choice)
    record("tool " + tool["type"], {**base, "tools": [tool]})
    record("tool " + tool["type"] + " populated nested fields", {**base, "tools": [sample(choice, full=True)]})
    bad = {k: v for k, v in tool.items() if k != "type"}
    record("tool " + tool["type"] + " dictionary fallback", {**base, "tools": [bad]})

for field in ("tool_choice", "text"):
    for index, choice in enumerate(schema["properties"][field]["anyOf"]):
        if choice.get("type") == "null" or choice.get("$ref", "").endswith("ToolChoiceAllowedParam"):
            continue
        record(field + " variant " + str(index), {**base, field: sample(choice, full=True)})
    record(field + " invalid scalar", {**base, field: 17})

for value in [True, False, "true", "FALSE", "t", "F", "y", "N", "yes", "No", "on", "OFF", "1", "0", "invalid", " true "]:
    record("boolean " + repr(value), {**base, "parallel_tool_calls": value})
for value in ["2", "2.0", "2e1", "0x10", " 2 ", "1_0", 2.5, True]:
    record("integer " + repr(value), {**base, "max_output_tokens": value})
for value in [None, 17, ["scalar", {"type": "reasoning", "content": None}], {"provider": True}]:
    record("constructed output " + repr(value), {**base, "output": value})
record("incomplete details defaults", {**base, "incomplete_details": {}})
record("invalid incomplete details constructs", {**base, "incomplete_details": {"reason": "invalid"}, "output": [dict(type="function_call", call_id="call", name="bash", arguments="{}")]})
record("async alias exact", {**base, "output": [dict(type="function_call", call_id="call", name="bash", arguments="{}", **{"async": True, "async_": False})]})
record("async alias precedence", {**base, "output": [dict(type="function_call", call_id="call", name="bash", arguments="{}", **{"async": "true", "async_": False})]})

iterators = []
for mode in (None, "python", "other", "json"):
    body = {**base, "tool_choice": dict(type="allowed_tools", mode="auto", tools=[dict(type="function", name="bash"), dict(type="function", name="next")])}
    response = transform(body)
    first = response.model_dump(**({"mode": mode} if mode else {}))
    first["tool_choice"]["tools"] = list(first["tool_choice"]["tools"])
    iterators.append(dict(mode=mode, body=body, first=first, after=response.model_dump(mode="json")))
record("tool_choice allowed invalid iterable", {**base, "tool_choice": dict(type="allowed_tools", mode="auto", tools=17)})

selected = {"output": schema["properties"]["output"]["anyOf"][0], **{key: schema["properties"][key] for key in ("tools", "tool_choice", "text", "incomplete_details")}}
used = {}
def clean(node):
    if isinstance(node, list):
        return [clean(x) for x in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = node["$ref"].rsplit("/", 1)[1]
        if name not in used:
            used[name] = {}
            used[name] = clean(defs[name])
            if name in records:
                used[name]["record"] = True
    return {k: ({field: clean(spec) for field, spec in v.items()} if k == "properties" else clean(v)) for k, v in node.items() if k not in ("title", "description", "discriminator")}
selected = clean(selected)
from openai.types.responses.tool_choice_allowed_param import ToolChoiceAllowedParam
assert get_origin(get_type_hints(ToolChoiceAllowedParam)["tools"]) is Iterable
used["ToolChoiceAllowedParam"]["properties"]["tools"]["iterable"] = True
(root.parent / "data" / "responses-schema.json").write_text(json.dumps(dict(fields=selected, models=used), indent=2) + "\n")
(root / "responses-serialization.json").write_text(json.dumps(dict(oracle="LiteLLM 1.108.3, capture-responses-serialization.py, no HTTP send", modes=["json", "python", "other"], iterators=iterators, defaults=transform(base).model_dump(), cases=[{**row, "dump": {key: value for key, value in row["dump"].items() if transform(base).model_dump().get(key) != value}} for row in cases]), ensure_ascii=False, indent=2) + "\n")
print([(r["name"], r["live_types"]) for r in cases])
