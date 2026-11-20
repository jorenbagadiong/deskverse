import * as THREE from "three"

/**
 * React Three Fiber 9 (latest stable) still creates a `THREE.Clock` for every
 * canvas, and three r183+ deprecated Clock in favor of `THREE.Timer`, so each
 * page load printed a deprecation warning that no Deskverse code can fix.
 *
 * three.js routes its own log/warn/error output through `setConsoleFunction`.
 * This drops exactly that one known third-party message and forwards
 * everything else unchanged. Remove it once R3F stops using Clock (v10).
 */
const SILENCED = [
  "THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.",
]

type StackTrace = { isStackTrace: true; getError: (message: string) => Error }
const isStackTrace = (value: unknown): value is StackTrace =>
  typeof value === "object" &&
  value !== null &&
  (value as { isStackTrace?: boolean }).isStackTrace === true

if (!THREE.getConsoleFunction()) {
  THREE.setConsoleFunction(
    (type: "log" | "warn" | "error", message: string, ...params: unknown[]) => {
      // Only that exact warning; errors and logs always go through.
      if (type === "warn" && SILENCED.includes(message)) return
      // Same output as three's default handler.
      if (isStackTrace(params[0])) console[type](params[0].getError(message))
      else console[type](message, ...params)
    },
  )
}
