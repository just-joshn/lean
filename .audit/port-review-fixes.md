# Port review fixes.

## Behavior

The port review threads are fixed at their public seams.

Mode commands use a null-prototype map and own-key membership, so inherited names cannot set a mode. Raised step and cost limits parse like Python `int` and `float`, including underscores, and reject trailing junk and hexadecimal forms. The CLI cost limit rejects non-finite values. The default config path reads `MSWEA_MINI_CONFIG_PATH` before the builtin file. An explicit empty task is a task, not a prompt. Setup runs after help, asks for the key variable name, writes that name, and persists `MSWEA_CONFIGURED=true`.

YAML keeps the PyYAML 6.0.3 behavior measured against the local cache. The schema stays on 1.1 with narrowed bool and exponent resolvers, because the 1.2 core schema turns `yes` and `off` into strings. CLI `NaN` and `Infinity` parse like Python. Integer strings past the safe range reject. Invalid UTF-8 is a structured `string_unicode` validation error. String dictionaries report every key. Local and Docker share `uname -p` for `processor`, with `unknown` and failure becoming an empty string.

## Verification

The focused suite passes 93 tests across ten files. `bun check` passes 78 files and the formatter passes 88. The processor tests use controlled subprocess results and literal values through the local and Docker template variables. No real PTY, live provider, network, install, Docker command, signal, full suite, or hook was used.

## Open gates

- The full suite is not rerun in this unit.
- The environment lifetime, judge adoption, and prompt warning gates are unchanged.
