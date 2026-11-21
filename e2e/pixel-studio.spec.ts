import { expect, test } from "./fixtures"
import {
  fillValidStoryboard,
  makePng,
  MISSING_REPORT,
  mockCapabilities,
  openStudio,
  READY_REPORT,
  STUDIO_PATH,
} from "./pixel-studio-helpers"

/** DV-003A: Pixel Studio, the storyboard-only foundation of the video engine. */
test.describe("Pixel Studio", () => {
  test("is reachable from the header and loads without errors", async ({
    page,
  }) => {
    await mockCapabilities(page, MISSING_REPORT)
    await page.goto("/")
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Studio" })
      .click()
    await expect(page).toHaveURL(new RegExp(`${STUDIO_PATH}$`))
    await expect(
      page.getByRole("heading", { level: 1, name: "Pixel Studio" }),
    ).toBeVisible()
    await expect(page).toHaveTitle(/Pixel Studio/)
    // States plainly that FFmpeg assembles supplied media.
    await expect(page.getByText(/doesn't generate AI footage/)).toBeVisible()
  })

  test("explains a missing FFmpeg with install steps", async ({ page }) => {
    await openStudio(page, MISSING_REPORT)
    const status = page.getByRole("status").filter({ hasText: "Not installed" })
    await expect(status).toContainText(
      "FFmpeg isn't available on this computer yet.",
    )
    await expect(
      page.getByText(/FFmpeg wasn't found on this computer/),
    ).toBeVisible()
    await expect(
      page.getByText(/FFprobe wasn't found on this computer/),
    ).toBeVisible()
    await expect(page.getByText("sudo apt install -y ffmpeg")).toBeVisible()
    await expect(
      page
        .getByRole("list", { name: "Render requirements" })
        .getByText("FFmpeg ready on this computer: not yet"),
    ).toBeAttached()
  })

  test("shows the detected tools when FFmpeg is ready, and re-checks on request", async ({
    page,
  }) => {
    const urls = await mockCapabilities(page, MISSING_REPORT, READY_REPORT)
    await page.goto(STUDIO_PATH)
    await expect(page.getByText("Not installed")).toBeVisible()

    await page.getByRole("button", { name: "Check again" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: "Ready" }),
    ).toBeVisible()
    expect(urls.at(-1)).toMatch(/\?refresh=1$/)
    await expect(
      page.getByText("libx264 (of libx264, h264_nvenc)"),
    ).toBeVisible()
    await expect(page.getByText("11/11 required")).toBeVisible()
    await expect(page.getByText("GPL build")).toBeVisible()
    await expect(page.getByText("sudo apt install -y ffmpeg")).toHaveCount(0)
  })

  test("validates the form and links each problem to its field", async ({
    page,
  }) => {
    await openStudio(page)
    await page.getByRole("button", { name: "Check storyboard" }).click()

    const summary = page.getByRole("heading", {
      name: "Fix 5 problems to complete the storyboard",
    })
    await expect(summary).toBeVisible()
    // Focus moves to the summary so screen readers announce it.
    await expect(page.locator(":focus")).toContainText("Fix 5 problems")

    const name = page.getByLabel("Product name")
    await expect(name).toHaveAttribute("aria-invalid", "true")
    await expect(name).toHaveAccessibleDescription(/Enter a product name\./)
    await expect(page.getByLabel("Product images")).toHaveAttribute(
      "aria-invalid",
      "true",
    )

    await page.getByRole("link", { name: "Enter a video headline." }).click()
    await expect(page.getByLabel("Video headline")).toBeFocused()

    await name.fill("Trailblazer travel mug")
    await expect(name).not.toHaveAttribute("aria-invalid", "true")
    await expect(
      page.getByRole("heading", {
        name: "Fix 4 problems to complete the storyboard",
      }),
    ).toBeVisible()

    // Over-long text is reported with its length; invisible characters are refused.
    await name.fill("x".repeat(61))
    await expect(name).toHaveAccessibleDescription(
      /60 characters or fewer \(currently 61\)/,
    )
    await name.fill("Buy\u202Enow")
    await expect(name).toHaveAccessibleDescription(
      /invisible or control characters/,
    )
  })

  test("shows field errors on blur before the first check", async ({
    page,
  }) => {
    await openStudio(page)
    const cta = page.getByLabel("Call to action")
    await expect(cta).not.toHaveAttribute("aria-invalid", "true")
    await cta.focus()
    await cta.blur()
    await expect(cta).toHaveAttribute("aria-invalid", "true")
    await expect(page.getByText("Enter a call to action.")).toBeVisible()
  })

  test("adds and removes benefit captions (1–5)", async ({ page }) => {
    await openStudio(page)
    const add = page.getByRole("button", { name: "Add benefit" })
    for (let n = 2; n <= 5; n++) {
      await add.click()
      await expect(
        page.getByLabel(`Benefit ${n}`, { exact: true }),
      ).toBeFocused()
    }
    await expect(add).toBeDisabled()
    const scenes = page
      .getByRole("list", { name: "Storyboard scenes" })
      .getByRole("listitem")
    await expect(scenes).toHaveCount(7)

    await page.getByRole("button", { name: "Remove benefit 3" }).click()
    await expect(page.getByLabel("Benefit 5", { exact: true })).toHaveCount(0)
    await expect(add).toBeEnabled()
    await expect(scenes).toHaveCount(6)
  })

  test("previews the storyboard from the inputs", async ({ page }) => {
    await openStudio(page)
    const board = page.getByRole("list", { name: "Storyboard scenes" })
    await expect(board.getByRole("listitem")).toHaveCount(3)
    await expect(page.getByText(/3 scenes · 15 s/)).toBeVisible()

    await page.getByLabel("Video headline").fill("Hot coffee for 12 hours")
    await page.getByLabel("Benefit 1", { exact: true }).fill("Leak-proof lid")
    await page.getByLabel("Call to action").fill("Tap the link to shop")
    await expect(board.getByRole("listitem").nth(0)).toContainText(
      "Hot coffee for 12 hours",
    )
    await expect(board.getByRole("listitem").nth(1)).toContainText(
      "Leak-proof lid",
    )
    await expect(board.getByRole("listitem").nth(2)).toContainText(
      "Tap the link to shop",
    )
    // The disclosure appears on every scene.
    for (const scene of await board.getByRole("listitem").all())
      await expect(scene).toContainText("I may earn a commission")

    // Scene frames are 9:16.
    const box = await page.getByTestId("scene-frame").first().boundingBox()
    expect(box!.width / box!.height).toBeCloseTo(9 / 16, 2)
  })

  test("accepts supported images and rejects unsupported ones", async ({
    page,
  }) => {
    await openStudio(page)
    const input = page.getByLabel("Product images")
    await input.setInputFiles([
      {
        name: "hero.png",
        mimeType: "image/png",
        buffer: await makePng(page, 900, 1200),
      },
      {
        name: "logo.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from("<svg onload=alert(1)/>"),
      },
      {
        name: "tiny.png",
        mimeType: "image/png",
        buffer: await makePng(page, 100, 100),
      },
      {
        name: "huge.png",
        mimeType: "image/png",
        buffer: Buffer.alloc(11 * 1024 * 1024),
      },
      {
        name: "fake.png",
        mimeType: "image/png",
        buffer: Buffer.from("not really a png"),
      },
    ])

    await expect(
      page.getByRole("img", { name: "Product image 1: hero.png" }),
    ).toBeVisible()
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "Some files weren't added" })
    await expect(alert).toContainText("“logo.svg” isn't a supported image")
    await expect(alert).toContainText("“tiny.png” is 100×100 px")
    await expect(alert).toContainText("Images must be 10 MB or smaller")
    await expect(alert).toContainText("“fake.png” couldn't be read as an image")
    await expect(
      page.getByRole("list", { name: "Selected images" }).getByRole("listitem"),
    ).toHaveCount(1)

    // The hero image appears in the storyboard as a local blob: preview.
    const sceneImage = page.getByTestId("scene-frame").first().locator("img")
    await expect(sceneImage).toHaveAttribute("src", /^blob:/)

    await page.getByRole("button", { name: "Remove hero.png" }).click()
    await expect(
      page.getByRole("list", { name: "Selected images" }),
    ).toHaveCount(0)
  })

  test("keeps Render unavailable in Phase A, even when everything else is ready", async ({
    page,
  }) => {
    await openStudio(page, READY_REPORT)
    const render = page.getByRole("button", { name: "Render MP4" })
    await expect(render).toBeDisabled()
    await expect(render).toHaveAccessibleDescription(
      /Rendering isn't available yet/,
    )
    await expect(render).toHaveAccessibleDescription(/DV-003B/)

    await fillValidStoryboard(page)
    await page.getByRole("button", { name: "Check storyboard" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: "Storyboard complete" }),
    ).toBeVisible()
    const requirements = page.getByRole("list", { name: "Render requirements" })
    await expect(
      requirements.getByText("Storyboard complete: done"),
    ).toBeAttached()
    await expect(
      requirements.getByText("FFmpeg ready on this computer: done"),
    ).toBeAttached()
    await expect(
      requirements.getByText("Render engine (DV-003B): not yet"),
    ).toBeAttached()
    await expect(render).toBeDisabled()
  })

  test("every control has an accessible name and is keyboard reachable", async ({
    page,
  }) => {
    await openStudio(page)
    const unnamed = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "main input, main textarea, main button, main a[href]",
        ),
      ]
        .filter((el) => {
          const labelledBy = el.getAttribute("aria-labelledby")
          const name =
            el.getAttribute("aria-label") ||
            (labelledBy && document.getElementById(labelledBy)?.textContent) ||
            (el.id &&
              document.querySelector(`label[for="${el.id}"]`)?.textContent) ||
            el.textContent
          return !name?.trim()
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    )
    expect(unnamed).toEqual([])

    // Tab from the product name reaches the (visually hidden) image input.
    await page.getByLabel("Product name").focus()
    await page.keyboard.press("Tab")
    await expect(page.getByLabel("Product images")).toBeFocused()
  })
})

test.describe("FFmpeg capability endpoint", () => {
  test("answers this machine without exposing paths or environment", async ({
    request,
  }) => {
    const response = await request.get("/api/studio/pixel/capabilities")
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    const body = await response.json()
    expect(["ready", "missing", "unsupported"]).toContain(body.status)
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/\/(usr|home|opt|bin)\/|[A-Z]:\\|--prefix|PATH=/)
  })

  test("refuses DNS-rebinding hosts and cross-site callers", async ({
    request,
  }) => {
    const rebinding = await request.get("/api/studio/pixel/capabilities", {
      headers: { host: "evil.example" },
    })
    expect(rebinding.status()).toBe(403)
    const crossSite = await request.get("/api/studio/pixel/capabilities", {
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    })
    expect(crossSite.status()).toBe(403)
  })

  test("accepts no commands: other methods are not allowed", async ({
    request,
  }) => {
    const response = await request.post("/api/studio/pixel/capabilities", {
      data: { args: ["-i", "/etc/passwd"] },
    })
    expect(response.status()).toBe(405)
  })
})
