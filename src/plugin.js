// dredd — Doubt-Rated Escalation for Delegated Development.
// After each judged agent turn, a fresh-context judge call scores P(YES) that
// the turn actually handled the request. Below threshold it either posts an
// advisory note or tells the agent to hand off to a stronger subagent.
import { loadConfig, summarizeTurn, judge, log, verdictText, resolveJudge, SENTINEL } from "./dredd.js"

export default async function Dredd({ client }, options = {}) {
  const cfg = loadConfig(options)
  const judged = new Map() // sessionID -> last judged userMessageID
  const count = new Map() // sessionID -> escalations so far

  // No client calls during init: plugin load runs before the server accepts
  // requests, so awaiting the server's own API here deadlocks startup.
  let providers = null
  async function providerConfig() {
    if (providers) return providers
    try {
      const { data } = await client.config.get()
      providers = data?.provider ?? {}
    } catch {
      providers = {}
    }
    return providers
  }

  async function tryCase(sessionID) {
    const { data: session } = await client.session.get({ path: { id: sessionID } })
    if (!session || session.parentID) return // subagent runs are never judged
    const { data: messages = [] } = await client.session.messages({ path: { id: sessionID } })
    const turn = summarizeTurn(messages, cfg.summaryCap)
    if (!turn || !turn.prompt) return // compaction / auto-continue turns carry no user text
    const user = messages.find((m) => m.info.id === turn.userMessageID)?.info
    if (!cfg.agents.includes(user?.agent)) return
    if (turn.prompt.startsWith(SENTINEL)) return // our own injected message
    if (judged.get(sessionID) === turn.userMessageID) return // once per user turn
    judged.set(sessionID, turn.userMessageID) // set first: idle can fire twice
    if (!turn.last) return

    const target = resolveJudge(cfg, user.model, await providerConfig())
    const base = {
      sessionID,
      userMessageID: turn.userMessageID,
      agent: user.agent,
      provider: user.model?.providerID,
      threshold: cfg.threshold,
      mode: cfg.mode,
      toolCount: turn.toolCount,
      hadToolError: turn.hadError,
      summaryChars: turn.text.length,
    }
    if (!target) return log({ ...base, action: "no-judge-url" }, cfg.logPath)

    const t0 = Date.now()
    let pYes = null
    let method = null
    let reason = "judge"
    if (turn.last.info.error) {
      pYes = 0
      reason = "assistant-error"
    } else {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 60_000)
      try {
        ;({ pYes, method } = await judge(target.url, turn.text, {
          signal: ctrl.signal,
          model: target.model,
          system: cfg.judgeSystem,
          question: cfg.judgeQuestion,
          extra: cfg.judgeExtra,
        }))
      } finally {
        clearTimeout(timer)
      }
    }
    const judgeMs = Date.now() - t0

    let action = "none"
    if (pYes === null) action = "unknown"
    else if (pYes < cfg.threshold && cfg.mode !== "off") {
      const n = count.get(sessionID) ?? 0
      if (n >= cfg.maxPerSession) action = "cap"
      else {
        count.set(sessionID, n + 1)
        action = cfg.mode
        const text = verdictText(pYes, cfg)
        await client.session.promptAsync({
          path: { id: sessionID },
          body:
            cfg.mode === "auto"
              ? { agent: user.agent, parts: [{ type: "text", text }] }
              : { noReply: true, parts: [{ type: "text", text }] },
        })
      }
    }
    log({ ...base, judgeUrl: target.url, judgeModel: target.model, pYes, method, action, reason, judgeMs }, cfg.logPath)
  }

  return {
    event: async ({ event }) => {
      const p = event.properties ?? {}
      const idle = event.type === "session.idle" || (event.type === "session.status" && p.status?.type === "idle")
      if (!idle || !p.sessionID) return
      // fire and forget: never hold up OpenCode's event loop on a judge call
      tryCase(p.sessionID).catch((e) =>
        log({ sessionID: p.sessionID, action: "error", error: String(e).slice(0, 200) }, cfg.logPath),
      )
    },
  }
}
