# Deskverse roadmap

**Version 1.1:** Affiliate Ticket architecture (approved 2026-11-21)
**Environment:** your own computer, Windows 11 + WSL2 Ubuntu
**Current milestone:** DV-004A, Local PostgreSQL Foundation

## 1. Vision

Deskverse is a local-first, ticket-driven AI affiliate marketing platform.

The owner creates an **Affiliate Ticket** containing one or more products,
affiliate links, media, reference URLs, instructions and publishing
preferences. Seven specialised workers collaborate on it. They:

- research products;
- create content;
- check quality;
- prepare finished videos;
- schedule approved content;
- publish it through authorised methods;
- track performance.

```
Create Affiliate Ticket → Scout → Quill → Pixel → Vera → Approval Inbox → Tempo → Relay → Ledger
```

The owner handles requests, exceptions and approvals. The workers do the
repeatable tasks.

## 2. Architecture

| Layer                | Technology                                           |
| -------------------- | ---------------------------------------------------- |
| Web application      | Next.js 16, React 19, TypeScript                     |
| Styling              | Tailwind CSS v4, shadcn/ui                           |
| Database             | Local PostgreSQL (DV-004A)                           |
| ORM                  | Drizzle ORM                                          |
| Background execution | Dedicated local Node.js/TypeScript worker (DV-004C)  |
| AI                   | Optional local model through Ollama                  |
| Video production     | Existing FFmpeg/FFprobe engine (Pixel Studio)        |
| Media storage        | Private local filesystem                             |
| Virtual office       | three.js and React Three Fiber                       |
| Testing              | Vitest, Playwright, real FFmpeg and PostgreSQL tests |

Everything runs locally. No external AI subscription or cloud hosting is
required.

## 3. Affiliate Ticket data model (planned)

| Entity                 | Holds                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AffiliateTicket**    | The owner's request: title, description, priority, target platform, approval and publishing preferences                                                                             |
| **TicketProduct**      | One product in a ticket: name, affiliate link, images, optional product videos, reference links, descriptions/specifications, notes, media rights and provenance, processing status |
| **WorkerTask**         | A persistent task for one worker: dependencies, attempts, state, timestamps, errors, outputs                                                                                        |
| **Deliverable**        | A versioned result: research brief, script, storyboard, video, QA report, publishing material, analytics                                                                            |
| **ApprovalDecision**   | Approve / reject / request revision, linked to an exact deliverable version                                                                                                         |
| **PublishingSchedule** | An approved deliverable's platform, date/time, publishing status and result                                                                                                         |
| **AuditEvent**         | A durable record of significant actions, transitions, failures and decisions                                                                                                        |

Each ticket has a stable internal identifier. The proposed display format is
`AFT-0001`.

Example: _AFT-0001 · November Affiliate Campaign · 10 products · TikTok ·
approval required · one approved video per day._

## 4. Completed milestones

| Milestone              | Description                    | Status                                                           |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------- |
| DV-001                 | Brand and design system        | Complete                                                         |
| DV-002 / DV-002B       | Interactive 3D office          | Implemented; further phases planned                              |
| DV-003A                | Pixel Studio foundation        | Complete                                                         |
| DV-003B                | Real FFmpeg video rendering    | Complete                                                         |
| DV-003C                | Voiceover and music            | Complete                                                         |
| DV-003D1               | Render management and recovery | Complete                                                         |
| DV-003D2               | Cinematic effects and EXIF     | Complete                                                         |
| DV-003D3               | Audio refinements              | Complete                                                         |
| WebP compatibility fix | WebP upload validation         | Complete                                                         |
| DV-004A                | Local PostgreSQL foundation    | Complete (see [database architecture](database-architecture.md)) |

These are separate from the Affiliate Ticket system they support.

## 5. Upcoming milestones

### Phase 1: Affiliate Ticket foundation

**DV-004A: Local PostgreSQL Foundation.** PostgreSQL, Drizzle, migrations,
database access, local security, backups and restore.
_Acceptance:_ data persists across restarts; existing Pixel Studio behaviour
remains intact.

**DV-004B: Affiliate Ticket Management** ← next. Adds:

- the `/tickets`, `/tickets/new` and `/tickets/[ticketId]` pages;
- creating, editing, saving and archiving tickets;
- product entries (one product or many per ticket);
- media uploads, affiliate links and reference materials;
- activity history.

_Acceptance:_ create a ticket with 10 products, restart the application, and
reopen all the saved information.

### Phase 2: Automated workflow

**DV-004C: Durable Campaign Orchestrator.** Task dependencies, worker
assignment, bounded concurrency, persistence, cancellation, retries,
pause/resume and restart recovery. Pixel renders **one video at a time**;
other workers continue independent work.
_Acceptance:_ a 10-product test batch processes with isolated failures and
no duplicate outputs after interruption or recovery.

### Phase 3: Automated content production

- **DV-005A: Scout (research).** Verify product details, retrieve permitted
  references, capture evidence, identify missing information, and prepare
  structured product briefs.
- **DV-005B: Quill (scriptwriting).** Hooks, narration, captions, benefits,
  calls to action and storyboards, from verified product facts.
- **DV-005C: Pixel (video production).** Connect the existing FFmpeg
  pipeline to Affiliate Tickets, turning validated scripts and product media
  into versioned MP4 deliverables.

_Acceptance:_ one Affiliate Ticket progresses automatically from valid
inputs to a verified video, without separate manual worker commands.

### Phase 4: Review and approval

- **DV-006A: Vera (quality review).** Check product claims, disclosures,
  media rights, captions, technical output and audio/video timing. Failed
  outputs go back for a limited number of revisions, or ask for human input.
- **DV-006B: Approval Inbox.** `/approvals` with:
  - video previews, scripts, QA results and affiliate links;
  - approval decisions and revision requests;
  - version tracking and bulk selection.

  Approvals apply only to specific deliverable versions.

_Acceptance:_ six approved products can proceed independently while other
products are processing, blocked or under revision.

### Phase 5: Publishing

- **DV-007A: Tempo (scheduling).** `/schedule` with publishing windows,
  daily limits, time zones, conflicts, priorities and rescheduling. Only
  approved content is scheduled.
- **DV-007B: Relay (publishing).** Prepare MP4 exports, captions,
  disclosures and links. Record manual publishing confirmations first; add
  authorised official publishing integrations later, if they are available.

_Acceptance:_ publication status accurately distinguishes Scheduled,
Publishing, Published and Failed.

### Phase 6: Performance and virtual office

- **DV-008A: Ledger (analytics).** Track publications, views, clicks,
  conversions, commissions, costs and campaign performance, from actual
  recorded data.
- **DV-008B: Live Deskverse HQ.** Connect real worker-task events to the
  existing 3D/2D office, with simulation clearly separated from live
  operations.

_Acceptance:_ employee states reflect real persisted tasks, not invented
progress.

### Phase 7: Batch validation

**DV-009: Affiliate Ticket Automation Pilot.** Run the complete workflow
with one product, then three, then ten. Verify:

- sequential rendering;
- independent failures;
- versioned approvals;
- queue recovery;
- media isolation;
- reliable scheduling.

_Acceptance:_ ten products move through the workflow with minimal manual
intervention beyond necessary corrections and approvals.

### Phase 8: Optional expansion

- **DV-010: Advanced production.** More video templates, direct video
  clips, richer audio editing, creative variants, batch imports, better
  scheduling.
- **DV-011: SaaS feasibility.** Hosting, accounts, billing and multi-user
  access are reconsidered only if the local-first product proves its value
  and the project direction changes.

## 6. Application navigation (planned)

| Page              | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| Dashboard         | Affiliate Ticket and worker overview                |
| Affiliate Tickets | Create and monitor requests                         |
| Approvals         | Review and approve finished content                 |
| Schedule          | Tempo publishing calendar                           |
| Deskverse HQ      | Visual employee workspace                           |
| Pixel Studio      | Video editing and rendering                         |
| Publications      | Relay publishing history                            |
| Analytics         | Ledger performance reports                          |
| Settings          | Local tools, database, media and backup preferences |

## 7. Operating rules

- One active Pixel video render at a time.
- Products inside a ticket progress independently, and one failed product
  never blocks the whole ticket.
- Human approval is required before publishing.
- Changing a deliverable invalidates the approvals it affects.
- Worker retries are finite and recoverable.
- Ticket assets survive failed renders and application restarts.
- Publishing prevents accidental duplicate actions.
- Product claims must be supported by evidence.
- Unauthorised third-party media is never republished.
- Workers distinguish actual execution from simulation.
- Local PostgreSQL and media storage need secure backups (DV-004A:
  `yarn db:backup`).

## 8. Development rules

- Work directly on `main`, one scoped milestone at a time.
- Inspect the existing implementation before changing it.
- Preserve existing Pixel Studio functionality.
- Add unit, integration and E2E coverage.
- Keep schema changes migration-safe: new versioned migrations only.
- Update documentation after each milestone.
- Stage only intended files, and commit locally after verification. Never
  push or deploy automatically.

## 9. MVP success

The MVP succeeds when the owner can:

1. Create an Affiliate Ticket.
2. Add one or more products and their materials.
3. Start processing once.
4. Let Scout, Quill and Pixel produce the videos automatically.
5. Receive Vera's QA results.
6. Review the deliverables in the Approval Inbox.
7. Approve them or request revisions.
8. Have Tempo schedule the approved content.
9. Use Relay to export or publish, with authorisation.
10. Review the results in Ledger.

The whole workflow keeps its history and recovers safely from interruptions.
