import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { APIRequestContext } from "@playwright/test"
import { FIXTURE_PRODUCTS } from "../scripts/scout/fixture-sites"
import { expect } from "./fixtures"
const rid = () => crypto.randomUUID()
const k = FIXTURE_PRODUCTS.kettle
function images(n: number, seed: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deskverse-e2e-images-"))
  const out: Buffer[] = []
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, `i${i}.png`)
    execFileSync("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=900x900:rate=1,hue=h=${(seed + i) * 53}`,
      "-frames:v",
      "1",
      "-y",
      file,
    ])
    out.push(readFileSync(file))
  }
  rmSync(dir, { recursive: true, force: true })
  return out
}

export async function waitRun(
  request: APIRequestContext,
  ticketId: string,
  workflow: string,
) {
  await expect
    .poll(
      async () => {
        const runs = (
          await (await request.get(`/api/tickets/${ticketId}/runs`)).json()
        ).runs as { workflow: string; status: string }[]
        return runs.find((r) => r.workflow === workflow)?.status
      },
      { timeout: 120_000 },
    )
    .toMatch(/^completed/)
}

/** A Ready ticket with images, Scout research and a Quill script. */
export async function seeded(
  request: APIRequestContext,
  title: string,
  n = 4,
  rights = "owned",
  runStandalone = true,
) {
  let ticket = (
    await (
      await request.post("/api/tickets", { data: { requestId: rid(), title } })
    ).json()
  ).ticket
  ticket = (
    await (
      await request.post(`/api/tickets/${ticket.id}/products`, {
        data: {
          requestId: rid(),
          name: k.name,
          affiliateUrl: k.affiliateUrl,
          specifications: k.specifications,
          description: k.description,
          references: k.references,
          mediaRights: rights,
        },
      })
    ).json()
  ).ticket
  const productId = ticket.products[0].id
  for (const [i, bytes] of images(n, title.length).entries()) {
    const r = await request.post(
      `/api/tickets/${ticket.id}/products/${productId}/assets`,
      {
        headers: {
          "content-type": "image/png",
          "x-file-name": `photo-${i}.png`,
        },
        data: bytes,
      },
    )
    expect(r.status(), await r.text()).toBe(201)
  }
  ticket = (await (await request.get(`/api/tickets/${ticket.id}`)).json())
    .ticket
  ticket = (
    await (
      await request.patch(`/api/tickets/${ticket.id}`, {
        data: { version: ticket.version, status: "ready" },
      })
    ).json()
  ).ticket
  const ready = {
    id: ticket.id as string,
    version: ticket.version as number,
    productId: productId as string,
    assetIds: ticket.products[0].assets.map(
      (asset: { id: string }) => asset.id,
    ) as string[],
  }
  if (!runStandalone) return ready
  expect(
    (
      await request.post(`/api/tickets/${ticket.id}/runs`, {
        data: {
          requestId: rid(),
          ticketVersion: ticket.version,
          mode: "production",
          workflow: "scout-research-v1",
        },
      })
    ).status(),
  ).toBe(201)
  await waitRun(request, ticket.id, "scout-research-v1")
  const report = (
    await (await request.get(`/api/tickets/${ticket.id}/scripts`)).json()
  ).products[0].reports[0].reportId
  expect(
    (
      await request.post(`/api/tickets/${ticket.id}/runs`, {
        data: {
          requestId: rid(),
          ticketVersion: ticket.version,
          mode: "production",
          workflow: "quill-script-v1",
          scripts: [{ productId, reportId: report }],
        },
      })
    ).status(),
  ).toBe(201)
  await waitRun(request, ticket.id, "quill-script-v1")
  return ready
}
