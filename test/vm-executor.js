/**
 * A stand-in for the connector's sandbox, for tests only.
 *
 * In production a script runs in a Dynamic Worker (worker/index.js). Node has
 * no such thing, and node:vm is NOT a security boundary, so this is never
 * wired into the server: a test hands it in as CODE_EXECUTOR. It keeps the
 * executor's contract: execute(code, [{ name, fns }]) resolves to
 * { result, error?, logs }, a failed call rejects with the host's message,
 * and what comes back is plain data.
 */
import vm from 'node:vm'

export function vmExecutor() {
  const runs = []
  return {
    runs,
    async execute(code, providers) {
      runs.push(code)
      const logs = []
      const line = (prefix) => (...parts) => logs.push(prefix + parts.map(String).join(' '))
      const sandbox = { console: { log: line(''), warn: line('[warn] '), error: line('[error] ') } }
      for (const provider of providers) {
        sandbox[provider.name] = new Proxy({}, {
          get: (_, name) => async (...args) => {
            const fn = provider.fns[name]
            if (!fn) throw new Error(`Tool "${String(name)}" not found`)
            // Across the real boundary arguments and results are copied, never shared.
            return structuredClone(await fn(...structuredClone(args)))
          },
        })
      }
      try {
        const fn = vm.runInNewContext(`(${code})`, sandbox, { timeout: 2000 })
        const result = await fn()
        return { result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)), logs }
      } catch (cause) {
        return { result: undefined, error: cause?.message || String(cause), logs }
      }
    },
  }
}
