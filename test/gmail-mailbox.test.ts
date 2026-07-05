import { describe, it, expect, vi } from "vitest";
import { GmailMailbox, type GmailApi } from "../src/mailbox.js";

const rawMsg = Buffer.from(
  [
    "From: Bob <Bob@Example.com>",
    "To: images@lafamilia.so",
    "Subject: hi",
    "Message-ID: <x@mail>",
    "Content-Type: text/plain",
    "",
    "make a cat",
    "",
  ].join("\r\n"),
);

function apiWith(over: {
  list?: any; get?: any; modify?: any; send?: any;
}): GmailApi {
  return {
    users: {
      messages: {
        list: over.list ?? vi.fn(),
        get: over.get ?? vi.fn(),
        modify: over.modify ?? vi.fn(),
        send: over.send ?? vi.fn(),
      },
    },
  } as unknown as GmailApi;
}

describe("GmailMailbox.fetchUnread", () => {
  it("queries unread inbox, decodes raw, returns id + threadId + parsed fields", async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: "m1" }] } });
    const get = vi.fn().mockResolvedValue({ data: { id: "m1", threadId: "t1", raw: rawMsg.toString("base64url") } });
    const box = new GmailMailbox(apiWith({ list, get }), "images@lafamilia.so");

    const emails = await box.fetchUnread();

    expect(list).toHaveBeenCalledWith({ userId: "me", q: "is:unread in:inbox" });
    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("m1");
    expect(emails[0].threadId).toBe("t1");
    expect(emails[0].from).toBe("bob@example.com");
    expect(emails[0].text).toBe("make a cat");
  });

  it("returns an empty list when there are no unread messages", async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });
    const box = new GmailMailbox(apiWith({ list }), "images@lafamilia.so");
    expect(await box.fetchUnread()).toEqual([]);
  });
});

describe("GmailMailbox.markRead", () => {
  it("removes the UNREAD label", async () => {
    const modify = vi.fn().mockResolvedValue({});
    await new GmailMailbox(apiWith({ modify }), "u").markRead("m1");
    expect(modify).toHaveBeenCalledWith({ userId: "me", id: "m1", requestBody: { removeLabelIds: ["UNREAD"] } });
  });
});

describe("GmailMailbox.send", () => {
  it("base64url-encodes a MIME body and sends with the threadId", async () => {
    const send = vi.fn().mockResolvedValue({});
    await new GmailMailbox(apiWith({ send }), "images@lafamilia.so").send({
      to: "bob@example.com",
      subject: "Re: hi",
      text: "done",
      filename: "result.jpg",
      inReplyTo: "<x@mail>",
      references: "<x@mail>",
      threadId: "t1",
    });

    expect(send).toHaveBeenCalledOnce();
    const arg = (send as any).mock.calls[0][0];
    expect(arg.userId).toBe("me");
    expect(arg.requestBody.threadId).toBe("t1");
    const decoded = Buffer.from(arg.requestBody.raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: bob@example.com");
    expect(decoded).toContain("Subject: Re: hi");
    expect(decoded).toContain("In-Reply-To: <x@mail>");
  });
});
