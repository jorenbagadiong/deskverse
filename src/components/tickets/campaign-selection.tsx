"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import type { CampaignSelection } from "@/lib/orchestrator/types"
import type { TicketDetail } from "@/lib/tickets/types"

interface Selection {
  assetIds: string[]
  acknowledged: boolean
}

export function CampaignPicker({
  ticket,
  disabled,
  onStart,
}: {
  ticket: TicketDetail
  disabled: boolean
  onStart: (selections: CampaignSelection[]) => void
}) {
  const [selected, setSelected] = useState<Record<string, Selection>>({})
  const products = ticket.products.map((product) => {
    const images = product.assets.filter((asset) => asset.kind === "image")
    const issue = !product.references.some(
      (ref) => ref.url !== product.affiliateUrl,
    )
      ? "Add a research reference besides the affiliate link."
      : images.length < 3
        ? "Upload at least three product images."
        : null
    return { product, images, issue }
  })
  function update(id: string, selection: Selection) {
    setSelected((current) => ({ ...current, [id]: selection }))
  }
  const choices = products.flatMap(({ product, images, issue }) => {
    const selection = selected[product.id]
    if (!selection || issue) return []
    return [
      {
        productId: product.id,
        assetIds: selection.assetIds.filter((id) =>
          images.some((image) => image.id === id),
        ),
        rightsAcknowledged: selection.acknowledged,
      },
    ]
  })
  const valid =
    choices.length > 0 &&
    choices.length === Object.keys(selected).length &&
    choices.every(
      (item) =>
        item.assetIds.length >= 3 &&
        item.assetIds.length <= 6 &&
        item.rightsAcknowledged,
    )

  return (
    <fieldset
      disabled={disabled}
      className="grid min-w-0 gap-3 rounded-xl p-3 ring-1 ring-border"
    >
      <legend className="font-semibold">Automatic campaign</legend>
      <p className="text-sm text-muted-foreground">
        Choose products and 3–6 images per product. Scout, Quill, Pixel and Vera
        run in order. Review each video in the Approval Inbox after QA.
      </p>
      {products.map(({ product, images, issue }) => {
        const selection = selected[product.id]
        return (
          <div
            key={product.id}
            className="grid min-w-0 gap-2 rounded-lg p-2 ring-1 ring-border"
          >
            <label className="flex items-start gap-2 text-sm font-medium break-words">
              <input
                type="checkbox"
                checked={Boolean(selection)}
                disabled={Boolean(issue)}
                onChange={(event) => {
                  if (event.currentTarget.checked)
                    update(product.id, { assetIds: [], acknowledged: false })
                  else
                    setSelected(({ [product.id]: removed, ...rest }) => {
                      void removed
                      return rest
                    })
                }}
              />
              {product.name}
            </label>
            {issue ? (
              <p className="text-sm text-muted-foreground">{issue}</p>
            ) : null}
            {selection && !issue ? (
              <>
                <fieldset className="grid min-w-0 gap-1">
                  <legend className="text-sm">
                    Images for {product.name} ({selection.assetIds.length}{" "}
                    selected)
                  </legend>
                  {images.map((image) => {
                    const position = selection.assetIds.indexOf(image.id)
                    return (
                      <div
                        key={image.id}
                        className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
                      >
                        <label className="flex min-w-0 items-start gap-2 break-all">
                          <input
                            type="checkbox"
                            checked={position >= 0}
                            disabled={
                              position === -1 && selection.assetIds.length >= 6
                            }
                            onChange={() =>
                              update(product.id, {
                                assetIds:
                                  position < 0
                                    ? [...selection.assetIds, image.id]
                                    : selection.assetIds.filter(
                                        (id) => id !== image.id,
                                      ),
                                acknowledged: false,
                              })
                            }
                          />
                          <span>
                            {position >= 0 ? `${position + 1}. ` : ""}
                            {image.displayName}
                          </span>
                        </label>
                        {position > 0 ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            aria-label={`Move ${image.displayName} earlier for ${product.name}`}
                            onClick={() => {
                              const assetIds = [...selection.assetIds]
                              assetIds.splice(position, 1)
                              assetIds.splice(position - 1, 0, image.id)
                              update(product.id, {
                                assetIds,
                                acknowledged: false,
                              })
                            }}
                          >
                            Move earlier
                          </Button>
                        ) : null}
                      </div>
                    )
                  })}
                </fieldset>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selection.acknowledged}
                    onChange={(event) =>
                      update(product.id, {
                        ...selection,
                        acknowledged: event.currentTarget.checked,
                      })
                    }
                  />
                  <span>
                    I confirm that I may use the selected images for{" "}
                    {product.name}. This records my statement. Verify your
                    license or permission separately.
                  </span>
                </label>
              </>
            ) : null}
          </div>
        )
      })}
      <Button
        type="button"
        className="w-fit max-w-full"
        disabled={!valid || disabled}
        onClick={() =>
          onStart(
            choices.map(({ productId, assetIds }) => ({
              productId,
              assetIds,
              rightsAcknowledged: true,
            })),
          )
        }
      >
        Start Automatic Campaign
      </Button>
    </fieldset>
  )
}
