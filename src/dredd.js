// dredd core: pure helpers + the judge call.
// Provider-agnostic: any OpenAI-compatible /chat/completions endpoint works.
// Logprobs are used when the server offers them; a text YES/NO parse is the fallback.
import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export const SENTINEL = "[dredd]"

export const LOG_PATH = join(stateDir(), "dredd.jsonl")

export const DEFAULTS = {
  threshold: 0.45,
  mode: "advisory", // advisory | auto | off
  maxPerSession: 3,
  agents: ["local"], // primary agents whose turns are judged
  escalateTo: "planner", // subagent the gated agent is told to invoke
  // Judge target. null = the same provider/model the judged turn ran on, with
  // the baseURL resolved from OpenCode's provider config, then providerUrls.
  judgeUrl: null,
  judgeModel: null,
  providerUrls: {}, // { providerID: baseURL } for providers OpenCode config does not expose
  judgeExtra: { chat_template_kwargs: { enable_thinking: false } }, // merged into the request; unknown servers ignore it
  summaryCap: 6000,
  judgeSystem:
    "You review the final turn of a coding agent. Reply with exactly one word, YES or NO. " +
    "YES: the response adequately handles the request. That includes a correct answer to a question, " +
    "a completed task, or correctly stopping to ask a necessary clarification. " +
    "NO: the agent failed, got stuck, gave up, hit errors it did not resolve, or left the task incomplete.",
  judgeQuestion: "Does this response adequately handle the request? Answer YES or NO.",
}

function xdg(envVar, fallback) {
  const v = process.env[envVar]
  return v && v.startsWith("/") ? v : join(homedir(), fallback)
}

export function configDir() {
  return join(xdg("XDG_CONFIG_HOME", ".config"), "opencode")
}

export function stateDir() {
  return join(xdg("XDG_STATE_HOME", ".local/state"), "opencode")
}

// Precedence: inline plugin options (opencode.json) > ~/.config/opencode/dredd.json > defaults.
export function loadConfig(options = {}, path = join(configDir(), "dredd.json")) {
  let file = {}
  try {
    file = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    /* no config file is fine */
  }
  return { ...DEFAULTS, ...file, ...options }
}

// P(yes) normalised over the yes/no mass in a top_logprobs list.
// null when neither class appears (the judge did not answer the question).
export function pYesFromTopLogprobs(top) {
  let yes = 0
  let no = 0
  for (const t of top ?? []) {
    const tok = String(t.token ?? "").trim().toLowerCase()
    const p = Math.exp(t.logprob)
    if (tok === "yes") yes += p
    else if (tok === "no") no += p
  }
  if (yes + no === 0) return null
  return yes / (yes + no)
}

// Binary fallback for endpoints without logprobs: the first YES/NO word wins.
export function pYesFromText(text) {
  const m = /\b(yes|no)\b/i.exec(String(text ?? ""))
  return m ? (m[1].toLowerCase() === "yes" ? 1 : 0) : null
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s)
const textOf = (parts) =>
  (parts ?? [])
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
    .trim()

// messages: [{info, parts}] as returned by client.session.messages.
// Builds the judge input for the last user turn. Deliberately does not rely on
// the agent emitting any structured status block; most models ignore that rule.
export function summarizeTurn(messages, cap = DEFAULTS.summaryCap) {
  const lastUser = messages.findLastIndex((m) => m.info.role === "user")
  if (lastUser < 0) return null
  const turn = messages.slice(lastUser)
  const prompt = textOf(turn[0].parts)
  const assistants = turn.slice(1).filter((m) => m.info.role === "assistant")
  const last = assistants.at(-1)
  const tools = []
  let hadError = Boolean(last?.info.error)
  for (const m of assistants) {
    for (const p of m.parts ?? []) {
      if (p.type !== "tool") continue
      const st = p.state ?? {}
      if (st.status === "error") hadError = true
      const args = trunc(JSON.stringify(st.input ?? {}), 120)
      const out = trunc(String(st.output ?? st.error ?? "").replace(/\s+/g, " "), 200)
      tools.push(`${p.tool}(${args}) → ${st.status ?? "?"}: ${out}`)
    }
  }
  const finalText = last ? textOf(last.parts) : ""
  const build = (t) =>
    `TASK:\n${trunc(prompt, 1500)}\n\nTOOL CALLS (${tools.length}${t.length < tools.length ? `, oldest ${tools.length - t.length} omitted` : ""}):\n${t.join("\n") || "(none)"}\n\nFINAL REPORT:\n${trunc(finalText, 2500) || "(empty)"}`
  let kept = tools
  let text = build(kept)
  while (text.length > cap && kept.length) {
    kept = kept.slice(1)
    text = build(kept)
  }
  return { text: trunc(text, cap), prompt, toolCount: tools.length, hadError, userMessageID: turn[0].info.id, last }
}

// Which endpoint/model judges a turn that ran on `model` ({providerID, modelID}).
// providers: { [providerID]: { options?: { baseURL } } } from OpenCode config.
export function resolveJudge(cfg, model, providers = {}) {
  const url =
    cfg.judgeUrl ?? providers[model?.providerID]?.options?.baseURL ?? cfg.providerUrls?.[model?.providerID] ?? null
  const judgeModel = cfg.judgeModel ?? (cfg.judgeUrl ? null : model?.modelID) ?? null
  return url ? { url, model: judgeModel } : null
}

async function complete(baseUrl, body, signal) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`judge HTTP ${res.status}`)
  return res.json()
}

// Returns { pYes, method }. method: "logprobs" | "text" | null.
export async function judge(
  baseUrl,
  summaryText,
  { signal, model, system = DEFAULTS.judgeSystem, question = DEFAULTS.judgeQuestion, extra = DEFAULTS.judgeExtra } = {},
) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `${summaryText}\n\n${question}` },
  ]
  const base = { ...(model ? { model } : {}), temperature: 0, messages, ...(extra ?? {}) }
  const r1 = await complete(baseUrl, { ...base, max_tokens: 1, logprobs: true, top_logprobs: 5 }, signal)
  const c1 = r1?.choices?.[0]
  const fromLogprobs = pYesFromTopLogprobs(c1?.logprobs?.content?.[0]?.top_logprobs)
  if (fromLogprobs !== null) return { pYes: fromLogprobs, method: "logprobs" }
  const fromFirst = pYesFromText(c1?.message?.content)
  if (fromFirst !== null) return { pYes: fromFirst, method: "text" }
  // No logprobs and no answer in one token (e.g. a reasoning model that ignores
  // enable_thinking): let it write a short answer and parse that.
  const r2 = await complete(baseUrl, { ...base, max_tokens: 48 }, signal)
  const m2 = r2?.choices?.[0]?.message ?? {}
  return { pYes: pYesFromText(m2.content) ?? pYesFromText(m2.reasoning_content), method: "text" }
}

export function log(entry, path = LOG_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n")
  } catch {
    /* logging must never break the hook */
  }
}

// The message injected back into the session. Flavour stays in the prefix; the
// instruction itself is plain and imperative so a small model acts on it.
export function verdictText(pYes, cfg) {
  const p = `${SENTINEL} GUILTY p=${pYes === null ? "n/a" : pYes.toFixed(2)} < ${cfg.threshold.toFixed(2)}.`
  return cfg.mode === "auto"
    ? `${p} Case referred to ${cfg.escalateTo}: invoke it now with a 10-line handoff (goal, files, what you tried, exact error). Do not retry yourself.`
    : `${p} Say "escalate" to refer the case to ${cfg.escalateTo}.`
}
