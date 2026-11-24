import {
  allowConsoleError,
  expect,
  noHorizontalOverflow,
  test,
} from "./fixtures"

test("navigates to the inbox by keyboard and fits narrow screens in both themes", async ({
  page,
}) => {
  await page.route(/\/api\/approvals\?/, (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  )
  await page.goto("/")
  const link = page.getByRole("link", { name: "Approvals", exact: true })
  await link.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Approval Inbox" }),
  ).toBeVisible()
  const candidates = page.getByRole("region", { name: "Candidates" })
  await expect(
    candidates.getByRole("button", { name: "Apply filters" }),
  ).toBeVisible()
  for (const width of [360, 375]) {
    await page.setViewportSize({ width, height: 800 })
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.classList.remove("light", "dark")
        document.documentElement.classList.add(value)
      }, theme)
      await noHorizontalOverflow(page)
    }
  }
})

test("reviews versions, confirms bulk approval, records revision and handles a stale decision", async ({
  page,
}) => {
  // Key interactions are exercised with an isolated API fixture. The database
  // suite covers decisions against real Pixel and Vera records.
  const products = ["Desk lamp", "Kettle", "Tripod", "Mug"]
  const ids = products.map(
    (_, index) => `8142b9db-8fe3-4da4-b153-0fc50a944ef${index}`,
  )
  const events = new Map<
    string,
    { id: string; kind: string; review_id: string; reason: string }
  >()
  const reviewId = "cff10b20-bdfb-4cbd-bfd6-30dcacc9d361"
  const stamp = new Date().toISOString()
  let stale = false
  const save = (id: string, decision: { kind: string; reason: string }) => {
    const item = {
      ...decision,
      id: crypto.randomUUID(),
      review_id: reviewId,
      created_at: stamp,
      deliverable_version: 1,
      review_version: 1,
    }
    events.set(id, item)
    return item
  }
  await page.route(/\/videos\/[^/]+\/file(?:[?]|$)/, (route) =>
    route.fulfill({ contentType: "video/mp4", body: "" }),
  )
  await page.route(/\/api\/approvals(?:[/?]|$)/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const [, , , id, action] = url.pathname.split("/")
    if (!id) {
      const offset = Number(url.searchParams.get("offset"))
      const search = url.searchParams.get("search")?.toLowerCase() ?? ""
      return route.fulfill({
        json: {
          hasMore: !offset && !search,
          items: ids.flatMap((id, index) =>
            (offset ? index === 3 : index < 3) &&
            products[index].toLowerCase().includes(search)
              ? [
                  {
                    id,
                    ticket_number: index + 1,
                    product_name: products[index],
                    platform: "tiktok",
                    deliverable_version: 1,
                    script_version: 1,
                    review_version: 1,
                    verdict: "pass",
                    decision: events.get(id)?.kind ?? "pending",
                    same_review: true,
                    historical: false,
                    updated_at: stamp,
                  },
                ]
              : [],
          ),
        },
      })
    }
    if (id === "bulk") {
      const { items } = request.postDataJSON()
      expect(items).toHaveLength(2)
      expect(
        items.every(
          (item: { decision: { checklist: Record<string, boolean> } }) =>
            Object.values(item.decision.checklist).every(Boolean),
        ),
      ).toBe(true)
      return route.fulfill({
        json: {
          results: items.map(
            ({
              deliverableId,
              decision,
            }: {
              deliverableId: string
              decision: { kind: string; reason: string }
            }) => ({
              deliverableId,
              ok: true,
              decision: save(deliverableId, decision),
            }),
          ),
        },
      })
    }
    const decision = events.get(id) ?? null
    if (action === "history")
      return route.fulfill({
        json: { items: decision ? [decision] : [], hasMore: false },
      })
    if (action === "decisions") {
      if (stale)
        return route.fulfill({
          status: 409,
          json: {
            message:
              "Another decision was recorded. Reload and review the current history.",
          },
        })
      return route.fulfill({
        json: { decision: save(id, request.postDataJSON()) },
      })
    }
    return route.fulfill({
      json: {
        candidate: {
          id,
          ticketId: ids[0],
          ticketNumber: ids.indexOf(id) + 1,
          version: 1,
          scriptVersion: 1,
          snapshot: {
            ticket: {
              title: "Affiliate review",
              instructions: "Fixture campaign",
            },
            product: {
              name: products[ids.indexOf(id)],
              description: "Product details",
              affiliateUrl: "https://example.invalid/?item=1",
              mediaRights: "owned",
              mediaRightsNote: "",
            },
          },
        },
        decision,
        eligibility: {
          eligible: decision?.kind === "approved",
          canApprove: !decision,
          historical: false,
          requiredOwnerActions: [],
        },
        review: {
          id: reviewId,
          version: 1,
          document: { verdict: "pass", findings: [] },
        },
        script: {
          disclosure: { text: "Affiliate disclosure" },
          scenes: [
            {
              id: "scene-1",
              kind: "hook",
              narration: "Review fixture details.",
              caption: "Fixture caption",
              visual: "Fixture visual",
            },
          ],
        },
        sources: [],
      },
    })
  })
  await page.goto("/approvals")
  const list = page.getByRole("region", { name: "Candidates" })
  await list.getByRole("button", { name: "Next" }).click()
  await expect(list.getByRole("button", { name: /Mug/ })).toBeVisible()
  await list.getByRole("button", { name: "Previous" }).click()
  const detail = page.getByRole("article", { name: "Selected video review" })
  const choose = detail.getByRole("combobox", { name: "Decision", exact: true })
  for (const product of products.slice(0, 2)) {
    await list.getByRole("button", { name: new RegExp(product) }).click()
    await choose.selectOption("approved")
    await expect(
      detail.getByRole("button", { name: "Add to bulk review" }),
    ).toBeDisabled()
    const checklist = detail.getByRole("group", { name: "Human checklist" })
    for (const item of await checklist.getByRole("checkbox").all())
      await item.check()
    await detail.getByRole("button", { name: "Add to bulk review" }).click()
  }
  await page.getByRole("button", { name: "Review bulk approval" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm.getByText("Desk lamp · Pixel v1")).toBeVisible()
  await expect(confirm.getByText("Kettle · Pixel v1")).toBeVisible()
  await confirm.getByRole("button", { name: "Confirm decision" }).click()
  await expect(
    detail.getByText("Human Approved — Not Scheduled", { exact: true }).first(),
  ).toBeVisible()

  await list.getByRole("button", { name: /Tripod/ }).click()
  await choose.selectOption("revision_requested")
  await detail
    .getByLabel("Reason", { exact: true })
    .fill("Captions cover the product.")
  await detail.getByLabel("Caption", { exact: true }).check()
  await detail.getByLabel("scene-1", { exact: true }).check()
  await detail
    .getByLabel("Expected correction")
    .fill("Move the captions lower.")
  await detail.getByRole("button", { name: "Review decision" }).click()
  await confirm.getByRole("button", { name: "Confirm decision" }).click()
  await expect(
    detail.getByText("Revision Requested", { exact: true }).first(),
  ).toBeVisible()

  await list.getByRole("button", { name: "Next" }).click()
  await list.getByRole("button", { name: /Mug/ }).click()
  await choose.selectOption("rejected")
  await detail.getByLabel("Reason", { exact: true }).fill("Wrong product.")
  allowConsoleError(page, /status of 409/)
  stale = true
  await detail.getByRole("button", { name: "Review decision" }).click()
  await confirm.getByRole("button", { name: "Confirm decision" }).click()
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Another decision was recorded" }),
  ).toBeVisible()
  stale = false
  await detail.getByRole("button", { name: "Review decision" }).click()
  await confirm.getByRole("button", { name: "Confirm decision" }).click()
  await expect(
    detail.getByText("Rejected", { exact: true }).first(),
  ).toBeVisible()
})
