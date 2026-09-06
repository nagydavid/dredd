// Single export on purpose: OpenCode treats every exported function in a
// plugin module as its own plugin entry, so exporting the same function twice
// would register two judges and double every verdict.
export { default } from "./src/plugin.js"
