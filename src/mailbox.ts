import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";

export interface IncomingEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  imageAttachment?: Buffer;
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
  const image = p.attachments.find((a) => (a.contentType ?? "").startsWith("image/"));
  const references = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  return {
    id,
    threadId,
    from,
    subject: p.subject ?? "",
    text: (p.text ?? "").trim(),
    imageAttachment: image?.content,
    messageId: p.messageId ?? "",
    references,
  };
}

export function buildReply(
  incoming: IncomingEmail,
  opts: { text: string; image?: Buffer; filename?: string },
): OutgoingReply {
  const subject = incoming.subject.startsWith("Re:") ? incoming.subject : `Re: ${incoming.subject}`;
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

export class Mailbox {
  constructor(private config: AppConfig) {}

  private client(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap.host,
      port: 993,
      secure: true,
      auth: { user: this.config.imap.user, pass: this.config.imap.password },
      logger: false,
    });
  }

  async fetchUnread(): Promise<IncomingEmail[]> {
    const client = this.client();
    const out: IncomingEmail[] = [];
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
          if (!msg.source) continue;
          out.push(await parseIncoming(msg.source as Buffer, String(msg.uid), ""));
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    return out;
  }

  async markRead(id: string): Promise<void> {
    const client = this.client();
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd({ uid: id }, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async send(reply: OutgoingReply): Promise<void> {
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: 465,
      secure: true,
      auth: { user: this.config.smtp.user, pass: this.config.smtp.password },
    });
    await transport.sendMail({
      from: this.config.smtp.user,
      to: reply.to,
      subject: reply.subject,
      text: reply.text,
      inReplyTo: reply.inReplyTo || undefined,
      references: reply.references || undefined,
      attachments: reply.image ? [{ filename: reply.filename, content: reply.image }] : [],
    });
  }
}
