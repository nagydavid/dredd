# dredd

**D**oubt-**R**ated **E**scalation for **D**elegated **D**evelopment.

An [OpenCode](https://opencode.ai) plugin. Your local model does the work. After
every turn, dredd asks a judge one question, gets one token back, and reads the
answer's probability. When the local model is floundering, dredd escalates to a
stronger agent. When it isn't, dredd says nothing.

> I AM THE LAW.

## Why

The usual way to make a local agent escalate is to write a rule in its prompt:
*"hand off when the task touches three or more files, or after two failed
attempts."* That asks the weakest model in the system to judge its own
competence, and it does not reliably comply. In the sessions that motivated
this plugin, a local model followed a mandated status-block rule in 1 turn out
of 48.

dredd replaces that judgement with a measurement. A separate call, with no
history and no stake in the outcome, is asked whether the turn actually handled
the request. It may answer with exactly one token, so the answer's logprobs give
a usable probability rather than a coin flip. That number is the gate.

This is the confidence-cascade pattern: run the cheap model first, score the
result, escalate only on low confidence.

## Install

```bash
npm install opencode-dredd     # or: bun add opencode-dredd
```

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["opencode-dredd"]
}
```

Requires OpenCode 1.18 or newer and any OpenAI-compatible local endpoint
(llama.cpp, vLLM, SGLang, Ollama, LM Studio).

## Configure

Inline options win over `~/.config/opencode/dredd.json`, which wins over the
defaults. Restart OpenCode after changing either.

```jsonc
{
  "plugin": [["opencode-dredd", { "mode": "auto", "threshold": 0.5 }]]
}
```

| Key | Default | Meaning |
|---|---|---|
| `threshold` | `0.45` | Escalate below this P(handled). |
| `mode` | `"advisory"` | `advisory` posts a note, `auto` hands off, `off` only logs. |
| `agents` | `["local"]` | Primary agents whose turns are judged. |
| `escalateTo` | `"planner"` | Subagent the judged agent is told to invoke. |
| `maxPerSession` | `3` | Cap on escalations per session. |
| `judgeUrl` | `null` | Pin a judge endpoint. Default follows the judged turn's own provider. |
| `judgeModel` | `null` | Pin a judge model, e.g. a small fast one. |
| `providerUrls` | `{}` | `{providerID: baseURL}` for providers OpenCode's config does not expose. |
| `judgeExtra` | thinking off | Merged into the judge request body. |
| `judgeSystem`, `judgeQuestion` | see `dredd.example.json` | The judge prompt. |

The judged agent needs permission to call `escalateTo`:

```jsonc
"agent": {
  "local": { "permission": { "task": { "*": "deny", "planner": "allow" } } }
}
```

## How it works

1. On `session.idle`, dredd looks at the last user turn. Subagent sessions, its
   own injected messages, compaction turns, and agents outside `agents` are all
   skipped, and each turn is judged at most once.
2. It builds a compact transcript: the request, each tool call with truncated
   arguments and output, and the final response. Oldest tool calls are dropped
   first to stay under `summaryCap`.
3. It asks the judge for one token. With logprobs, P(yes) is the yes mass over
   the yes-plus-no mass. Without them, the YES/NO text is parsed and the score
   is 0 or 1.
4. Below `threshold`, it either posts an advisory note or instructs the agent to
   hand off. Every verdict is appended to `~/.local/state/opencode/dredd.jsonl`.

A turn whose assistant message carries an error scores 0 without consulting the
judge.

## Calibrate

Pick a threshold from your own history rather than trusting the default. The
script rescores past turns from OpenCode's database, read-only.

```bash
python3 scripts/calibrate.py            # judge each turn on the provider it ran on
python3 scripts/calibrate.py --url http://127.0.0.1:11435/v1 --limit 20
```

It prints one row per turn sorted by score, so you can see where the gap between
good turns and stuck ones falls. On the author's history that gap was wide:
stuck or blocked turns scored at or below 0.07, and turns that answered the
question scored at or above 0.61. Hence a default of 0.45.

## Watch it

```bash
tail -f ~/.local/state/opencode/dredd.jsonl
```

Each line records the score, the method (`logprobs` or `text`), the judge
endpoint and model, the action taken, and how long the judge took.

## Known behaviour

A well-argued *"this is infeasible, here is why"* scores low and triggers an
escalation. That is intended: a blocked task is exactly when a second opinion is
worth paying for. If you disagree, raise `threshold` or reword `judgeSystem`.

Text-only endpoints give a binary score, so `threshold` becomes a yes/no switch
rather than a dial. Prefer an endpoint with logprobs if you want to tune it.

## Test

```bash
bun test test/
```

The live judge test skips itself when no local endpoint is reachable.

## License

MIT
