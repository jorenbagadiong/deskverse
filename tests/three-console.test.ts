import * as THREE from "three"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const CLOCK_WARNING =
  "THREE.Clock: This module has been deprecated. Please use THREE.Timer instead."

describe("three.js console filter", () => {
  beforeAll(async () => {
    await import("@/components/office/scene/three-console")
  })
  afterEach(() => vi.restoreAllMocks())

  const handler = () => {
    const fn = THREE.getConsoleFunction()
    if (!fn) throw new Error("console function not installed")
    return fn as (type: string, message: string, ...params: unknown[]) => void
  }

  it("is installed through three's own console hook", () => {
    expect(THREE.getConsoleFunction()).toBeTypeOf("function")
  })

  it("drops only the known THREE.Clock deprecation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // The real path: R3F constructs a Clock, three warns through the hook.
    new THREE.Clock()
    handler()("warn", CLOCK_WARNING)
    expect(warn).not.toHaveBeenCalled()
  })

  it("forwards every other warning unchanged, including near-misses", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    handler()("warn", "THREE.WebGLRenderer: Context Lost.", { detail: 1 })
    handler()("warn", `${CLOCK_WARNING} (extra)`)
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "THREE.WebGLRenderer: Context Lost.",
      { detail: 1 },
    )
    expect(warn).toHaveBeenNthCalledWith(2, `${CLOCK_WARNING} (extra)`)
  })

  it("forwards errors and logs, so genuine failures stay visible", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    handler()("error", "THREE.WebGLProgram: Shader Error 1282")
    // Even the Clock text is never swallowed when it arrives as an error.
    handler()("error", CLOCK_WARNING)
    handler()("log", "THREE.Info: ready")
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith("THREE.WebGLProgram: Shader Error 1282")
    expect(log).toHaveBeenCalledWith("THREE.Info: ready")
  })

  it("keeps three's stack-trace formatting for forwarded messages", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const trace = {
      isStackTrace: true as const,
      getError: (message: string) => new Error(`${message} @ trace`),
    }
    handler()("error", "THREE.Renderer: failed", trace)
    expect(error).toHaveBeenCalledWith(
      new Error("THREE.Renderer: failed @ trace"),
    )
  })
})
