import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

// Inline images below this are almost certainly tracking pixels or spacer/icon
// graphics, not a picture the user wants edited. Real content easily exceeds it.
const MIN_INLINE_IMAGE_BYTES = 1024;

export interface IncomingEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  imageAttachments: Buffer[];
  messageId: string;
  references: string;
}

export interface OutgoingReply {
  to: string;
  subject: string;
  text: string;
  image?: Buffer;
  filename: string;
  inReplyTo: string;
  references: string;
  threadId: string;
}

export async function parseIncoming(raw: Buffer, id: string, threadId: string): Promise<IncomingEmail> {
  const p = await simpleParser(raw);
  const from = (p.from?.value?.[0]?.address ?? "").toLowerCase();
  // Collect image parts the user meant as content. A real file attachment counts
  // regardless of size (they deliberately attached it). An inline image (pasted
  // into the body / HTML-embedded) also counts — that's how many people send a
  // picture to edit — but only above a tiny threshold, so tracking pixels and
  // spacer/icon graphics don't get mistaken for the image to edit.
  const imageAttachments = p.attachments
    .filter((a) => {
      if (!(a.contentType ?? "").startsWith("image/")) return false;
      const isInline = a.contentDisposition === "inline" || a.related === true;
      return !isInline || (a.content?.length ?? 0) >= MIN_INLINE_IMAGE_BYTES;
    })
    .map((a) => a.content);
  const references = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  return {
    id,
    threadId,
    from,
    subject: p.subject ?? "",
    text: (p.text ?? "").trim(),
    imageAttachments,
    messageId: p.messageId ?? "",
    references,
  };
}

export function buildReply(
  incoming: IncomingEmail,
  opts: { text: string; image?: Buffer; filename?: string },
): OutgoingReply {
  const subject = /^re:/i.test(incoming.subject) ? incoming.subject : `Re: ${incoming.subject}`;
  const references = [incoming.references, incoming.messageId].filter(Boolean).join(" ");
  return {
    to: incoming.from,
    subject,
    text: opts.text,
    image: opts.image,
    filename: opts.filename ?? "result.jpg",
    inReplyTo: incoming.messageId,
    references,
    threadId: incoming.threadId,
  };
}

export interface GmailApi {
  users: {
    messages: {
      list(params: { userId: string; q: string }): Promise<{ data: { messages?: Array<{ id?: string | null }> } }>;
      get(params: { userId: string; id: string; format: "raw" }): Promise<{ data: { id?: string | null; threadId?: string | null; raw?: string | null } }>;
      modify(params: { userId: string; id: string; requestBody: { removeLabelIds: string[] } }): Promise<unknown>;
      send(params: { userId: string; requestBody: { raw: string; threadId?: string } }): Promise<unknown>;
    };
  };
}

export class GmailMailbox {
  constructor(private api: GmailApi, private user: string) {}

  async fetchUnread(): Promise<IncomingEmail[]> {
    const list = await this.api.users.messages.list({ userId: "me", q: "is:unread in:inbox" });
    const ids = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const out: IncomingEmail[] = [];
    for (const id of ids) {
      const msg = await this.api.users.messages.get({ userId: "me", id, format: "raw" });
      const raw = msg.data.raw;
      if (!raw) continue;
      const buf = Buffer.from(raw, "base64url");
      out.push(await parseIncoming(buf, msg.data.id ?? id, msg.data.threadId ?? ""));
    }
    return out;
  }

  async markRead(id: string): Promise<void> {
    await this.api.users.messages.modify({
      userId: "me",
      id,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  }

  async send(reply: OutgoingReply): Promise<void> {
    const mail = new MailComposer({
      from: this.user,
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments: reply.image ? [{ filename: reply.filename, content: reply.image }] : [],
    });
    const mime: Buffer = await new Promise((resolve, reject) => {
      mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
    });
    const raw = mime.toString("base64url");
    await this.api.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: reply.threadId || undefined },
    });
  }
}
