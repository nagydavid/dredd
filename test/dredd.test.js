import { test, expect } from "bun:test"
import {
  pYesFromTopLogprobs,
  pYesFromText,
  summarizeTurn,
  judge,
  loadConfig,
  verdictText,
  resolveJudge,
  configDir,
  SENTINEL,
} from "../src/dredd.js"

// Recorded from llama.cpp (Qwen3.8-27B UD-Q4_K_XL) on 2026-09-06.
const PROBE = [
  { token: "NO", logprob: -0.331 },
  { token: "YES", logprob: -1.282 },
  { token: "No", logprob: -6.126 },
  { token: "Yes", logprob: -6.735 },
  { token: "no", logprob: -8.5 },
]

test("pYes from recorded probe ≈ 0.28; null when no yes/no tokens", () => {
  expect(pYesFromTopLogprobs(PROBE)).toBeCloseTo(0.28, 1)
  expect(pYesFromTopLogprobs([{ token: "Maybe", logprob: -0.1 }])).toBeNull()
  expect(pYesFromTopLogprobs(undefined)).toBeNull()
})

test("pYes from text: first yes/no word, binary, null otherwise", () => {
  expect(pYesFromText("YES")).toBe(1)
  expect(pYesFromText(" No, the agent gave up.")).toBe(0)
  expect(pYesFromText("Yesterday it worked")).toBeNull()
  expect(pYesFromText("")).toBeNull()
})

const msg = (role, id, parts, extra = {}) => ({ info: { id, role, sessionID: "s", ...extra }, parts })
const text = (t) => ({ type: "text", text: t })
const tool = (name, input, output, status = "completed") => ({ type: "tool", tool: name, state: { status, input, output } })

test("summarizeTurn keeps prompt + final text, truncates tool output, respects cap", () => {
  const big = "x".repeat(5000)
  const messages = [
    msg("user", "u0", [text("old task")]),
    msg("assistant", "a0", [text("old answer")]),
    msg("user", "u1", [text("rename foo to bar")], { agent: "local" }),
    msg("assistant", "a1", [tool("read", { filePath: "a.py" }, big), tool("edit", { filePath: "a.py" }, "ok"), text("Done.")]),
  ]
  const s = summarizeTurn(messages)
  expect(s.userMessageID).toBe("u1")
  expect(s.prompt).toBe("rename foo to bar")
  expect(s.text).toContain("rename foo to bar")
  expect(s.text).not.toContain("old task")
  expect(s.text).toContain("Done.")
  expect(s.text).toContain("read(")
  expect(s.text.length).toBeLessThan(1200) // the 5000-char output was truncated to 200
  expect(s.toolCount).toBe(2)
  expect(s.hadError).toBe(false)

  // compaction / auto-continue turns carry no user text
  expect(summarizeTurn([msg("user", "c", [{ type: "compaction" }]), msg("assistant", "a", [text("x")])]).prompt).toBe("")

  const many = Array.from({ length: 200 }, (_, i) => tool("bash", { command: `cmd ${i}` }, "y".repeat(200)))
  const capped = summarizeTurn([msg("user", "u2", [text("t")]), msg("assistant", "a2", [...many, text("end")])], 3000)
  expect(capped.text.length).toBeLessThanOrEqual(3000)
  expect(capped.text).toContain("omitted")
  expect(capped.text).toContain("end")
})

test("hadError set by a tool error or an assistant error", () => {
  const toolErr = summarizeTurn([
    msg("user", "u", [text("t")]),
    msg("assistant", "a", [{ type: "tool", tool: "bash", state: { status: "error", input: {}, error: "boom" } }]),
  ])
  expect(toolErr.hadError).toBe(true)
  const asstErr = summarizeTurn([msg("user", "u", [text("t")]), msg("assistant", "a", [], { error: { name: "ApiError" } })])
  expect(asstErr.hadError).toBe(true)
})

test("config precedence: inline options > file > defaults", () => {
  const cfg = loadConfig({}, "/nonexistent.json")
  expect(cfg.threshold).toBe(0.45)
  expect(cfg.agents).toEqual(["local"])
  expect(cfg.escalateTo).toBe("planner")
  const overridden = loadConfig({ threshold: 0.8, escalateTo: "architect" }, "/nonexistent.json")
  expect(overridden.threshold).toBe(0.8)
  expect(overridden.escalateTo).toBe("architect")
  expect(overridden.mode).toBe("advisory") // untouched keys keep their default
  expect(configDir()).toContain("opencode")
})

test("verdictText carries the sentinel and the configured target", () => {
  const cfg = loadConfig({}, "/nonexistent.json")
  expect(verdictText(0.31, cfg).startsWith(SENTINEL)).toBe(true)
  expect(verdictText(0.31, cfg)).toContain("planner")
  const auto = verdictText(0.06, { ...cfg, mode: "auto", escalateTo: "architect" })
  expect(auto).toContain("architect")
  expect(auto).toContain("Do not retry yourself")
})

test("resolveJudge: opencode provider config → providerUrls → judgeUrl override → none", () => {
  const cfg = loadConfig({}, "/nonexistent.json")
  const model = { providerID: "vllm", modelID: "Qwen/Qwen3-32B" }
  expect(resolveJudge(cfg, model, { vllm: { options: { baseURL: "http://gpu-box:8000/v1" } } })).toEqual({
    url: "http://gpu-box:8000/v1",
    model: "Qwen/Qwen3-32B",
  })
  expect(
    resolveJudge({ ...cfg, providerUrls: { ollama: "http://127.0.0.1:11434/v1" } }, { providerID: "ollama", modelID: "qwen3:8b" }, {}),
  ).toEqual({ url: "http://127.0.0.1:11434/v1", model: "qwen3:8b" })
  expect(resolveJudge({ ...cfg, judgeUrl: "http://127.0.0.1:9000/v1", judgeModel: "tiny" }, model, {})).toEqual({
    url: "http://127.0.0.1:9000/v1",
    model: "tiny",
  })
  expect(resolveJudge(cfg, { providerID: "anthropic", modelID: "claude-opus-5" }, {})).toBeNull()
})

test("judge falls back to text parsing when the endpoint returns no logprobs", async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const content = body.max_tokens === 1 ? "<think>" : "<think>hmm</think> NO, it gave up."
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }
  try {
    const r = await judge("http://fake/v1", "TASK: x", { model: "m" })
    expect(r).toEqual({ pYes: 0, method: "text" })
    expect(calls.length).toBe(2)
    expect(calls[0].logprobs).toBe(true)
    expect(calls[0].model).toBe("m")
    expect(calls[1].max_tokens).toBe(48)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("judge surfaces a non-200 as an error rather than a silent verdict", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("nope", { status: 503 })
  try {
    expect(judge("http://fake/v1", "TASK: x")).rejects.toThrow("judge HTTP 503")
  } finally {
    globalThis.fetch = realFetch
  }
})

// Live check against whatever local endpoint is configured, skipped when down.
const cfg = loadConfig()
const liveUrl = cfg.judgeUrl ?? cfg.providerUrls?.llamacpp ?? "http://127.0.0.1:11435/v1"
const up = await fetch(`${liveUrl}/models`)
  .then((r) => r.ok)
  .catch(() => false)

test.skipIf(!up)("live judge: a completed transcript scores higher than a failed one", async () => {
  const done =
    'TASK:\nrename foo to bar in src/a.py\n\nTOOL CALLS (3):\nread({"filePath":"src/a.py"}) → completed: def foo(): ...\nedit({"filePath":"src/a.py"}) → completed: ok\nbash({"command":"pytest -q"}) → completed: 12 passed in 0.4s\n\nFINAL REPORT:\nRenamed foo→bar in src/a.py, updated 2 call sites, pytest 12 passed.'
  const failed =
    'TASK:\nrename foo to bar in src/a.py\n\nTOOL CALLS (2):\nread({"filePath":"src/a.py"}) → error: ENOENT no such file\nbash({"command":"pytest -q"}) → completed: ERROR collecting, 0 passed 3 errors\n\nFINAL REPORT:\nI could not find the file. Tests are failing. I tried twice.'
  const opts = { system: cfg.judgeSystem, question: cfg.judgeQuestion, extra: cfg.judgeExtra }
  const [a, b] = await Promise.all([judge(liveUrl, done, opts), judge(liveUrl, failed, opts)])
  expect(a.pYes).toBeGreaterThan(b.pYes)
}, 120_000)
