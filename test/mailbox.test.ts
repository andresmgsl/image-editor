import { describe, it, expect } from "vitest";
import { parseIncoming, buildReply } from "../src/mailbox.js";

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
    expect(e.imageAttachment).toBeUndefined();
  });
});

describe("buildReply", () => {
  const incoming = {
    id: "m1", threadId: "t1", from: "alice@example.com", subject: "make a logo",
    text: "", messageId: "<abc@mail>", references: "",
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
});
