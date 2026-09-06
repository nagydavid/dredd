// isoblock — tool calls stay on local models.
//
// dredd decides *when* to escalate. isoblock decides *who may touch the repo*.
// An agent running on a metered remote model gets no read/edit/bash tools at
// all: it has to delegate, so its context fills with a subagent's summary
// instead of raw file contents and command output.
//
// The policy keys off the agent's provider, not its name, so an agent added to
// opencode.json later cannot silently acquire tools. It fails open: when the
// provider cannot be resolved, nothing is blocked.

export const ISOBLOCK_DEFAULTS = {
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
// network bills nothing per token, which is the only property isoblock cares about.
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
export function isLocalProvider(providerID, cfg = ISOBLOCK_DEFAULTS, providers = {}) {
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
export function isoVerdict({ tool, agent, providerID }, cfg, providers = {}) {
  if (!cfg || cfg.mode === "off") return null
  if (!cfg.block?.includes(tool)) return null
  if (agent && cfg.exempt?.includes(agent)) return null
  if (isLocalProvider(providerID, cfg, providers) !== false) return null
  return (
    `isoblock: "${tool}" is not available to ${agent ?? "this agent"} (${providerID}). ` +
    `Tool calls run on local models so this context stays small. ` +
    `Call the "${cfg.delegateTo}" subagent with the task tool and ask it for exactly ` +
    `what you need, then work from what it reports back.`
  )
}
