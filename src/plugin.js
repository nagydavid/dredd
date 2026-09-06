// stayhomedad — the local model does the job itself and calls a professional
// only when it is out of its depth.
//
// Two hooks. After each judged turn a fresh-context judge call scores P(YES)
// that the turn actually handled the request; below threshold it posts an
// advisory note or tells the agent to hand off. And an agent on a metered
// remote model is refused the repo tools, so it has to delegate and read a
// summary instead of the raw material.
import {
  loadConfig, summarizeTurn, judge, log, verdictText, resolveJudge, SENTINEL,
  TOOLS_DEFAULTS, toolVerdict,
} from "./stayhomedad.js"

export default async function StayHomeDad({ client }, options = {}) {
  const cfg = loadConfig(options)
  const tools = { ...TOOLS_DEFAULTS, ...(cfg.tools ?? {}) }
  const judged = new Map() // sessionID -> last judged userMessageID
  const count = new Map() // sessionID -> escalations so far
  const agentOf = new Map() // sessionID -> agent name

  // No client calls during init: plugin load runs before the server accepts
  // requests, so awaiting the server's own API here deadlocks startup.
  let conf = null
  async function appConfig() {
    if (conf) return conf
    try {
      const { data } = await client.config.get()
      conf = data ?? {}
    } catch {
      conf = {}
    }
    return conf
  }
  const providerConfig = async () => (await appConfig()).provider ?? {}

  // agent name -> providerID. Agents with no model of their own inherit the
  // top-level one, which is what OpenCode reports as null here.
  let agentProvider = null
  async function providerOfAgent(name) {
    if (!name) return null
    if (!agentProvider) {
      agentProvider = new Map()
      try {
        const { data = [] } = await client.app.agents()
        for (const a of data) agentProvider.set(a.name, a.model?.providerID ?? null)
      } catch {
        /* fall through to the default model below */
      }
    }
    const own = agentProvider.get(name)
    if (own) return own
    const fallback = (await appConfig()).model
    return typeof fallback === "string" ? fallback.split("/")[0] : null
  }

  // Agent for a session. Primary sessions are recorded by chat.message, child
  // sessions by the task call that spawned them; this is the last resort.
  async function agentForSession(sessionID) {
    if (agentOf.has(sessionID)) return agentOf.get(sessionID)
    let name = null
    try {
      const { data: messages = [] } = await client.session.messages({ path: { id: sessionID } })
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i].info
        if (info?.role === "user" && info.agent) {
          name = info.agent
          break
        }
      }
    } catch {
      /* unknown agent means no block */
    }
    agentOf.set(sessionID, name)
    return name
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
    log({ kind: "verdict", ...base, judgeUrl: target.url, judgeModel: target.model, pYes, method, action, reason, judgeMs }, cfg.logPath)
  }

  return {
    "chat.message": async (input) => {
      if (input?.sessionID && input.agent) agentOf.set(input.sessionID, input.agent)
    },

    "tool.execute.before": async ({ tool, sessionID }, output) => {
      // The task tool fires this against the *child* session it just created,
      // so this is where a subagent session learns which agent it is running.
      if (tool === "task") {
        const sub = output?.args?.subagent_type
        if (sessionID && sub) agentOf.set(sessionID, sub)
        return
      }
      if (tools.mode === "off" || !sessionID) return
      const agent = await agentForSession(sessionID)
      const providerID = await providerOfAgent(agent)
      const refusal = toolVerdict({ tool, agent, providerID }, tools, await providerConfig())
      if (!refusal) return
      log({ kind: "tools", sessionID, agent, provider: providerID, tool, action: tools.mode }, cfg.logPath)
      if (tools.mode === "enforce") throw new Error(refusal)
    },

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
