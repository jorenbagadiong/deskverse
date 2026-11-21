import type { Metadata } from "next"
import { Suspense } from "react"
import { LoaderCircle } from "lucide-react"

import { TicketWorkspace } from "@/components/tickets/ticket-workspace"

export const metadata: Metadata = {
  title: "Affiliate Ticket",
}

/**
 * The ticket ID is runtime data (Cache Components): it is read inside
 * Suspense and handed to the client workspace, which loads the ticket from
 * the local API. The build prerenders only this static shell and never
 * touches the database.
 */
export default function TicketPage({
  params,
}: PageProps<"/tickets/[ticketId]">) {
  return (
    <div className="mx-auto max-w-content px-gutter py-section sm:px-gutter-lg">
      <Suspense
        fallback={
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            Loading the Affiliate Ticket…
          </p>
        }
      >
        {params.then(({ ticketId }) => (
          <TicketWorkspace key={ticketId} ticketId={ticketId} />
        ))}
      </Suspense>
    </div>
  )
}
