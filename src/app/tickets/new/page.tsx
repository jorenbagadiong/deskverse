import type { Metadata } from "next"

import { NewTicketForm } from "@/components/tickets/ticket-form"

export const metadata: Metadata = {
  title: "New Affiliate Ticket",
}

export default function NewTicketPage() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-6 px-gutter py-section sm:px-gutter-lg">
      <header className="flex flex-col gap-2">
        <p className="text-eyebrow text-primary uppercase">Affiliate Tickets</p>
        <h1 className="text-headline sm:text-display">
          Create an Affiliate Ticket
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Start with a title. You can add products, affiliate links and media
          after saving.
        </p>
      </header>
      <NewTicketForm />
    </div>
  )
}
