import type { Metadata } from "next"

import { TicketList } from "@/components/tickets/ticket-list"

export const metadata: Metadata = {
  title: "Affiliate Tickets",
  description:
    "Your affiliate requests: products, links, references and media, stored on this computer.",
}

export default function TicketsPage() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-gutter py-section sm:px-gutter-lg">
      <header className="flex flex-col gap-2">
        <p className="text-eyebrow text-primary uppercase">
          DV-004B · Affiliate Tickets
        </p>
        <h1 className="text-headline sm:text-display">Affiliate Tickets</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Each ticket gathers the products, affiliate links, references and
          media for one request. Tickets are saved in local PostgreSQL on this
          computer.
        </p>
      </header>
      <TicketList />
    </div>
  )
}
