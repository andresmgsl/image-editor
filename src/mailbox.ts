import { simpleParser } from "mailparser";

export interface IncomingEmail {
  uid: number;
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
}

export async function parseIncoming(raw: Buffer, uid: number): Promise<IncomingEmail> {
  const p = await simpleParser(raw);
  const from = (p.from?.value?.[0]?.address ?? "").toLowerCase();
  const image = p.attachments.find((a) => (a.contentType ?? "").startsWith("image/"));
  const references = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  return {
    uid,
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
  };
}
