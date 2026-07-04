# Email-Driven Image Editor — Phase 1 Design

**Date:** 2026-07-04
**Status:** Approved design, pre-implementation

## Purpose

Let a team request image **creation** or **editing** by writing to a dedicated email
address. A server reads the inbox, uses Claude to understand the request and pick the
best Fal.ai model, generates the image, and replies to the sender with a low-resolution
version attached.

Phase 1 keeps it deliberately simple. Further features are explicitly out of scope (see
below) and will follow in later phases.

## Scope

**In scope (Phase 1):**
- Poll a Gmail/IMAP inbox for new requests.
- Restrict processing to an allowlist of team email addresses.
- Use Claude to interpret the email (text + optional attached image) and choose a Fal.ai
  model, task type, prompt, and parameters.
- Run the chosen Fal.ai model (text-to-image, or image edit when an image is attached).
- Reply in-thread with a low-resolution image attached.
- Basic error handling and duplicate-processing protection.

**Out of scope (later phases):**
- High-res delivery / download links.
- Concurrency / job queue.
- Web UI, dashboards, history.
- Multi-image workflows, iterative refinement threads.
- Billing / usage tracking per user.

## Tech stack

- **Runtime:** Node.js + TypeScript.
- **Email intake:** IMAP polling of a Gmail (or IMAP) mailbox; SMTP for replies.
- **Interpreter:** Claude API (Anthropic) using structured tool-use.
- **Image models:** Fal.ai.
- **Config/secrets:** `.env` (never committed).

## Architecture

A single long-running process running a sequential loop:

```
Gmail inbox  --IMAP poll (~15s)-->  Poller
                                      | new email from allowlisted sender
                                      v
                                   Interpreter (Claude)
                                      | { task, falModelId, prompt, params }
                                      v
                                   Fal-runner (calls chosen model)
                                      | result image URL
                                      v
                                   Replier: downscale -> SMTP reply in-thread
                                      |
                                      v
                                   Mark processed (dedup)
```

### Modules (each independently testable)

- **mailbox** — IMAP read (fetch unread, parse headers/body/attachments) and SMTP send
  (reply in-thread with attachment). Knows nothing about images or Claude.
- **interpreter** — given email text + whether an image is attached + the model catalog,
  calls Claude and returns a validated structured decision. Pure function of its inputs
  aside from the Claude call.
- **fal-runner** — given a decision (+ optional input image), calls the Fal.ai endpoint,
  waits for completion, returns the result image bytes. Knows nothing about email.
- **orchestrator** — the loop: poll, allowlist check, dedup, call interpreter, call
  fal-runner, call replier, mark processed. Handles errors at each step.

## Model catalog

The catalog is a single config file. Each entry: endpoint id, human description, task type
(`generate` | `edit`), and accepted params. Claude receives the descriptions and returns
the chosen endpoint id. **Adding or swapping a model = editing this one file**, no code
changes — this is what keeps future model additions cheap.

**Exact Fal.ai endpoint IDs are verified against fal.ai's live docs during implementation**
— they change over time and must not be hardcoded from memory without checking.

### Generation (text -> image)

| Model | When Claude picks it |
|---|---|
| Nano Banana Pro (Google) | Default quality pick — complex scenes, best text/typography |
| FLUX.2 [pro] | Photorealism, general high-fidelity |
| Seedream V4.5 | High-aesthetic, stylized / marketing imagery |
| Ideogram V4 | Requests where text/logos/posters matter |
| Recraft V3 | Design/brand/vector, icons, precise styles |
| FLUX schnell | Simple/quick asks where speed & cost win |

### Editing (attached image + instruction)

| Model | When Claude picks it |
|---|---|
| Nano Banana Pro Edit | Default edit pick — NL edits, text edits, subject consistency |
| FLUX Pro Kontext Max | Targeted local edits & scene transforms |
| Seedream Edit | Multi-image / style-consistent edits |
| Qwen Image Edit | Multilingual text-in-image edits |

## Data flow

1. **Poll:** Poller finds an unread email from an allowlisted sender.
2. **Parse:** subject + body become the instruction; any image attachment becomes the
   input image.
3. **Interpret:** Claude receives the text, whether an image is attached, and the catalog.
   Via structured tool-use it returns:
   ```json
   {
     "task": "edit",
     "falModelId": "<endpoint id from catalog>",
     "prompt": "refined prompt for the model",
     "aspectRatio": "1:1"
   }
   ```
   The decision is schema-validated; the chosen `falModelId` must exist in the catalog and
   match the task type.
4. **Generate:** fal-runner calls the endpoint (uploading the input image for edits), waits
   for completion, downloads the full-res result.
5. **Reply (low-res):** downscale result to **max 1024px long edge, JPEG ~80% quality**
   (keeps attachments to a few hundred KB). Send as an in-thread reply to the sender with a
   one-line note: e.g. `Edited with Nano Banana Pro Edit. Prompt: ...`.
6. **Mark processed:** record the email as done so the loop never reprocesses it.

### Defaults (chosen, changeable)

- "Low res" = 1024px long edge, JPEG quality ~80.
- Replies go **in-thread** so a requester sees their ask and the result together.

## Error handling & edge cases

- **Sender not on allowlist** → ignored silently, logged locally, no reply. Prevents
  strangers from spending API credits.
- **Request too vague / edit requested with no image attached** → reply asking for
  clarification; do not call Fal.
- **Fal job fails or times out** → reply with a short human error ("That one failed — try
  rephrasing"); log details locally.
- **Dedup / crash safety** → track processed message IDs (by IMAP UID). An email is only
  marked processed after a successful reply, so a crash mid-job does not drop or duplicate
  work. On restart, in-flight (unmarked) emails are retried.
- **Sequential processing** → one email at a time in Phase 1; no concurrency.
- **Secrets** → Fal key, Anthropic key, email credentials, and the allowlist live in
  `.env`, never committed.

## Configuration (`.env` / config)

- `ANTHROPIC_API_KEY`
- `FAL_KEY`
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` (Gmail: app password)
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`
- `ALLOWLIST` — comma-separated team email addresses.
- `POLL_INTERVAL_SECONDS` (default 15)

## Success criteria

A team member emails the inbox (from an allowlisted address) with either "make an image
of X" or an attached image + "change Y", and within a short time receives an in-thread
reply with a low-res image that reflects their request, produced by an appropriate Fal.ai
model.
