import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { RenderGate, type RenderLease } from "@/server/video/render-gate"

/**
 * A REAL render-gate lease for tests (DV-005C): renderVideo refuses to run
 * without one. Each call uses its own temporary lock folder, so test files
 * never contend with each other or with a real Deskverse installation.
 */
export async function testLease(): Promise<RenderLease> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deskverse-test-gate-"))
  return new RenderGate(dir).acquire({
    kind: "test",
    jobId: "test",
    storageRoot: dir,
  })
}
