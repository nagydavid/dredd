// stayhomedad core: pure helpers, the judge call, and the tool policy.
// Provider-agnostic: any OpenAI-compatible /chat/completions endpoint works.
// Logprobs are used when the server offers them; a text YES/NO parse is the fallback.
import { readFileSync, appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

export const SENTINEL = "[stayhomedad]"

export const LOG_PATH = join(stateDir(), "stayhomedad.jsonl")

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

// Precedence: inline plugin options (opencode.json) > ~/.config/opencode/stayhomedad.json > defaults.
export function loadConfig(options = {}, path = join(configDir(), "stayhomedad.json")) {
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
  const p = `${SENTINEL} p=${pYes === null ? "n/a" : pYes.toFixed(2)} < ${cfg.threshold.toFixed(2)}.`
  return cfg.mode === "auto"
    ? `${p} This one is past you. Call ${cfg.escalateTo} in now with a 10-line handoff (goal, files, what you tried, exact error). Do not retry yourself.`
    : `${p} This one may be past you. Say "escalate" to call ${cfg.escalateTo} in.`
}

// ---------------------------------------------------------------------------
// Tool policy. An agent on a metered remote model is refused the repo tools and
// has to delegate to a local subagent, so its context fills with summaries
// rather than file contents and command output.
//
// The policy keys off the agent's resolved provider, not its name, so an agent
// added to opencode.json later cannot silently acquire tools. It fails open:
// when the provider cannot be resolved, nothing is blocked.
// ---------------------------------------------------------------------------

export const TOOLS_DEFAULTS = {
  mode: "off", // enforce | warn | off
  // Providers always treated as local, on top of the loopback/LAN autodetect
  // below. Needed for providers OpenCode resolves from its catalog rather than
  // from your config, which carry no baseURL we can inspect.
  local: ["ollama", "lmstudio", "llamacpp", "llama-cpp", "vllm", "sglang", "localai"],
  remote: [], // providerIDs always treated as remote, overriding everything else
  // Tools a remote agent may not call. These are the repo-access tools, the
  // ones whose output is large and whose work a local subagent can do instead.
  // Everything else is allowed, so a tool added by a future OpenCode release
  // is not blocked until you say so.
  block: ["bash", "read", "glob", "grep", "edit", "write", "apply_patch"],
  exempt: [], // agent names that keep their tools regardless of provider
  delegateTo: "explore", // subagent named in the refusal
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])
// RFC1918, link-local, and the usual LAN suffixes. A model served from your own
// network bills nothing per token, which is the only property tools cares about.
const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/
const LOCAL_TLD = /\.(local|lan|internal|home|localdomain)$/

export function isLocalHost(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOOPBACK.has(host) || PRIVATE.test(host) || LOCAL_TLD.test(host)
}

// null = cannot tell. Callers must treat that as "do not block".
export function isLocalProvider(providerID, cfg = TOOLS_DEFAULTS, providers = {}) {
  if (!providerID) return null
  if (cfg.remote?.includes(providerID)) return false
  if (cfg.local?.includes(providerID)) return true
  const url = providers[providerID]?.options?.baseURL
  if (url) return isLocalHost(url)
  // Declared in the config with no baseURL, or resolved from the catalog: the
  // only providers that reach here in practice are the hosted ones.
  return false
}

// Returns the refusal string, or null to let the call through.
export function toolVerdict({ tool, agent, providerID }, cfg, providers = {}) {
  if (!cfg || cfg.mode === "off") return null
  if (!cfg.block?.includes(tool)) return null
  if (agent && cfg.exempt?.includes(agent)) return null
  if (isLocalProvider(providerID, cfg, providers) !== false) return null
  return (
    `stayhomedad: "${tool}" is not available to ${agent ?? "this agent"} (${providerID}). ` +
    `Tool calls run on local models so this context stays small. ` +
    `Call the "${cfg.delegateTo}" subagent with the task tool and ask it for exactly ` +
    `what you need, then work from what it reports back.`
  )
}
