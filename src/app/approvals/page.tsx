import type { Metadata } from "next"
import { ApprovalInbox } from "@/components/approvals/inbox"

export const metadata: Metadata = { title: "Approval Inbox" }

export default function ApprovalsPage() {
  return (
    <div className="mx-auto grid max-w-content gap-6 px-gutter py-section sm:px-gutter-lg">
      <header className="space-y-2">
        <h1 className="text-headline sm:text-display">Approval Inbox</h1>
        <p className="text-muted-foreground">
          Review Pixel videos, Vera findings and your decision history.
        </p>
      </header>
      <ApprovalInbox />
    </div>
  )
}
