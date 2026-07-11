import { describe, it, expect } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { parseIncoming, buildReply } from "../src/mailbox.js";

async function buildRaw(opts: Record<string, unknown>): Promise<Buffer> {
  const mail = new MailComposer(opts);
  return await new Promise((resolve, reject) =>
    mail.compile().build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg))),
  );
}

const rawEmail = Buffer.from(
  [
    "From: Alice <Alice@Example.com>",
    "To: bot@example.com",
    "Subject: make a logo",
    "Message-ID: <abc@mail>",
    "Content-Type: text/plain",
    "",
    "A minimalist fox logo, orange.",
    "",
  ].join("\r\n"),
);

describe("parseIncoming", () => {
  it("extracts id, threadId, sender (lowercased), subject, text, message id", async () => {
    const e = await parseIncoming(rawEmail, "m42", "t42");
    expect(e.id).toBe("m42");
    expect(e.threadId).toBe("t42");
    expect(e.from).toBe("alice@example.com");
    expect(e.subject).toBe("make a logo");
    expect(e.text).toBe("A minimalist fox logo, orange.");
    expect(e.messageId).toBe("<abc@mail>");
    expect(e.imageAttachments).toEqual([]);
  });

  it("collects every image attachment (in order) and ignores non-image files", async () => {
    const raw = await buildRaw({
      from: "Alice <alice@example.com>",
      to: "bot@example.com",
      subject: "edit these",
      text: "make it night",
      attachments: [
        { filename: "a.png", content: Buffer.from("imgA"), contentType: "image/png" },
        { filename: "notes.pdf", content: Buffer.from("pdfdata"), contentType: "application/pdf" },
        { filename: "b.jpg", content: Buffer.from("imgB"), contentType: "image/jpeg" },
      ],
    });
    const e = await parseIncoming(raw, "m", "t");
    expect(e.imageAttachments.map((b) => b.toString())).toEqual(["imgA", "imgB"]);
  });

  it("detects inline (pasted-in-body, not attached) images above the tiny threshold", async () => {
    const raw = await buildRaw({
      from: "alice@example.com",
      to: "bot@example.com",
      subject: "edit this",
      html: 'Please edit this <img src="cid:photo@x"> — thanks',
      attachments: [
        { filename: "photo.png", content: Buffer.alloc(2048, 9), contentType: "image/png", cid: "photo@x" },
      ],
    });
    const e = await parseIncoming(raw, "m", "t");
    expect(e.imageAttachments.length).toBe(1);
    expect(e.imageAttachments[0].length).toBe(2048);
  });

  it("drops tiny inline tracking-pixel / spacer images", async () => {
    const raw = await buildRaw({
      from: "alice@example.com",
      to: "bot@example.com",
      subject: "hello",
      html: 'hi there <img src="cid:pixel@x">',
      attachments: [
        { filename: "pixel.gif", content: Buffer.alloc(40, 0), contentType: "image/gif", cid: "pixel@x" },
      ],
    });
    const e = await parseIncoming(raw, "m", "t");
    expect(e.imageAttachments).toEqual([]);
  });
});

describe("buildReply", () => {
  const incoming = {
    id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a logo",
    text: "", imageAttachments: [], messageId: "<abc@mail>", references: "",
  };

  it("builds an in-thread reply with an image attachment and threadId", () => {
    const r = buildReply(incoming, { text: "done", image: Buffer.from("x"), filename: "result.jpg" });
    expect(r.to).toBe("alice@example.com");
    expect(r.subject).toBe("Re: make a logo");
    expect(r.inReplyTo).toBe("<abc@mail>");
    expect(r.references).toContain("<abc@mail>");
    expect(r.threadId).toBe("t1");
    expect(r.image).toBeInstanceOf(Buffer);
  });

  it("builds a text-only reply and does not double-prefix Re:", () => {
    const r = buildReply({ ...incoming, subject: "Re: make a logo" }, { text: "what next?" });
    expect(r.subject).toBe("Re: make a logo");
    expect(r.image).toBeUndefined();
  });

  it("does not double-prefix an uppercase RE: subject", () => {
    const r = buildReply({ ...incoming, subject: "RE: make a logo" }, { text: "ok" });
    expect(r.subject).toBe("RE: make a logo");
  });
});
