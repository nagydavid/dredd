import { expect, test } from "bun:test"
import { TOOLS_DEFAULTS, isLocalHost, isLocalProvider, toolVerdict } from "../src/stayhomedad.js"

const cfg = { ...TOOLS_DEFAULTS, mode: "enforce" }
const providers = { llamacpp: { options: { baseURL: "http://127.0.0.1:11435/v1" } } }

test("loopback and LAN hosts are local, public ones are not", () => {
  for (const u of ["http://127.0.0.1:11435/v1", "http://localhost:1234/v1", "http://192.168.1.9:8000", "http://box.lan:11434"])
    expect(isLocalHost(u)).toBe(true)
  for (const u of ["https://api.githubcopilot.com", "https://api.anthropic.com/v1", "not a url"])
    expect(isLocalHost(u)).toBe(false)
})

test("provider classification: config baseURL, name list, explicit remote", () => {
  expect(isLocalProvider("llamacpp", cfg, providers)).toBe(true)
  expect(isLocalProvider("ollama", cfg, {})).toBe(true) // catalog provider, no baseURL to inspect
  expect(isLocalProvider("github-copilot", cfg, providers)).toBe(false)
  expect(isLocalProvider("llamacpp", { ...cfg, remote: ["llamacpp"] }, providers)).toBe(false)
  expect(isLocalProvider(null, cfg, providers)).toBe(null) // cannot tell
})

test("local agents keep every tool", () => {
  for (const tool of ["read", "edit", "bash", "grep", "write", "apply_patch"])
    expect(toolVerdict({ tool, agent: "local", providerID: "llamacpp" }, cfg, providers)).toBe(null)
})

test("remote agents lose repo tools but keep task, question and unknown tools", () => {
  const blocked = toolVerdict({ tool: "read", agent: "planner", providerID: "github-copilot" }, cfg, providers)
  expect(blocked).toContain("explore")
  expect(blocked).toContain("planner")
  for (const tool of cfg.block)
    expect(toolVerdict({ tool, agent: "planner", providerID: "github-copilot" }, cfg, providers)).toContain("stayhomedad")
  // asking the user, delegating, and anything OpenCode adds later stay open
  for (const tool of ["task", "question", "todowrite", "skill", "invalid", "some_future_tool"])
    expect(toolVerdict({ tool, agent: "planner", providerID: "github-copilot" }, cfg, providers)).toBe(null)
})

test("fails open: unknown provider and mode off never block", () => {
  expect(toolVerdict({ tool: "read", agent: "mystery", providerID: null }, cfg, providers)).toBe(null)
  expect(toolVerdict({ tool: "read", agent: "planner", providerID: "github-copilot" }, TOOLS_DEFAULTS, providers)).toBe(null)
})

test("exempt list wins over the provider check", () => {
  const c = { ...cfg, exempt: ["reviewer"] }
  expect(toolVerdict({ tool: "read", agent: "reviewer", providerID: "github-copilot" }, c, providers)).toBe(null)
  expect(toolVerdict({ tool: "read", agent: "planner", providerID: "github-copilot" }, c, providers)).toContain("stayhomedad")
})
