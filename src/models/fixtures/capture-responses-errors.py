import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parent
home = tempfile.TemporaryDirectory(prefix="lean-responses-errors-")
os.environ.clear()
os.environ.update(HOME=home.name, PATH=os.defpath, LITELLM_LOCAL_MODEL_COST_MAP="true", MSWEA_SILENT_STARTUP="1", PYTHON_DOTENV_DISABLED="1")
os.chdir(home.name)
import httpx
import litellm
from litellm.llms.openai.common_utils import OpenAIError
from litellm.litellm_core_utils.exception_mapping_utils import exception_type
from litellm.llms.openai.responses.transformation import OpenAIResponsesAPIConfig
from minisweagent.models.litellm_response_model import LitellmResponseModel
from minisweagent.models.utils.actions_toolcall_response import parse_toolcall_actions_response
litellm.suppress_debug_info = True

class Logger:
    def post_call(self, **kwargs):
        pass

mapping = []
for status, text in [(401, '{"error":{"message":"clé invalide"}}'), (403, "forbidden"), (404, "missing"), (400, "This model's maximum context length is 100 tokens"), (400, "string_above_max_length: This model's maximum context length is 100 tokens"), (400, "maximum context length exceeded"), (400, "context_length_exceeded"), (400, "context unrelated word"), (400, "prompt is too long"), (400, "unsupported parameter"), (429, "rate limit"), (500, "server failed"), (200, "invalid é JSON\n")]:
    try:
        mapped = exception_type(model="gpt-4o", original_exception=OpenAIError(message=text, status_code=status), custom_llm_provider="openai")
        raise mapped
    except Exception as error:
        row = dict(status=status, text=text, name=type(error).__name__, message=error.message, string=str(error))
        model = LitellmResponseModel(model_name="openai/gpt-4o", cost_tracking="ignore_errors")
        with patch("litellm.responses", side_effect=error):
            try:
                model._query([])
            except Exception as suffixed:
                row["query_message"] = suffixed.message
        mapping.append(row)

base = dict(id="response", created_at=1, object="response", output=[])
wire = json.dumps({**base, "label": "é雪"}, ensure_ascii=False)
raws = [("utf8", wire.encode(), {}), ("utf8 bom", b"\xef\xbb\xbf" + wire.encode(), {}), ("utf16 bom", wire.encode("utf-16"), {}), ("utf32 bom", wire.encode("utf-32"), {}), ("latin1 charset", json.dumps({**base, "label": "é"}, ensure_ascii=False).encode("latin1"), {"content-type": "application/json; charset=iso-8859-1"}), ("invalid utf8", b'{"created_at":1,"label":"\xff"}', {}), ("utf8 declared latin1", wire.encode(), {"content-type": "application/json; charset=iso-8859-1"})]
decoding = []
for name, content, headers in raws:
    raw = httpx.Response(200, content=content, headers=headers, request=httpx.Request("POST", "http://unused.invalid"))
    row = dict(name=name, bytes=list(content), headers=headers, text=raw.text)
    try:
        row["dump"] = OpenAIResponsesAPIConfig().transform_response_api_response(model="gpt-4o", raw_response=raw, logging_obj=Logger()).model_dump()
    except Exception as error:
        row["error"] = dict(name=type(error).__name__, message=str(error))
    decoding.append(row)

import signal
with patch("litellm.responses", side_effect=lambda **kwargs: signal.raise_signal(signal.SIGINT)):
    try:
        LitellmResponseModel(model_name="openai/gpt-4o")._query([])
    except BaseException as error:
        interrupt = dict(name=type(error).__name__, message=str(error))

arguments = []
for value in ["", "{", "{bad}", '{"command":}', '{"command":"unterminated}', '{"command":"\\x"}', '{"command":"a\nb"}', '{"command":"pwd"} trailing', "[1,]", "null", 17, None, '{"command":"pwd"}']:
    item = dict(type="function_call", name="bash", call_id="call", arguments=value)
    row = dict(arguments=value)
    try:
        row["actions"] = parse_toolcall_actions_response([item], format_error_template="{{ error }}")
    except Exception as error:
        row["error"] = error.messages[0]["content"][0]["text"]
    arguments.append(row)

(root / "responses-errors.json").write_text(json.dumps(dict(oracle="LiteLLM 1.108.3 and mini-swe-agent 04d809ce, no sends", mapping=mapping, decoding=decoding, arguments=arguments, interrupt=interrupt), indent=2, ensure_ascii=False) + "\n")
