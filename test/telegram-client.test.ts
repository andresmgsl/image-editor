import { describe, it, expect, vi, afterEach } from "vitest";
import { TelegramClient } from "../src/telegram-client.js";

function getFileResponse(filePath: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { file_path: filePath } }),
    clone() {
      return getFileResponse(filePath);
    },
  } as unknown as Response;
}

describe("TelegramClient.getFileBuffer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a file download whose content-length exceeds the 20 MB cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(getFileResponse("photos/file_1.jpg"))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": String(21 * 1024 * 1024) }),
        arrayBuffer: vi.fn(),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("TOKEN");
    await expect(client.getFileBuffer("F1")).rejects.toThrow(/exceeds|too large|20 ?MB/i);
  });

  it("rejects an oversize body even when content-length is missing or understated", async () => {
    const bigBuf = new ArrayBuffer(21 * 1024 * 1024);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(getFileResponse("photos/file_1.jpg"))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        arrayBuffer: vi.fn().mockResolvedValue(bigBuf),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("TOKEN");
    await expect(client.getFileBuffer("F1")).rejects.toThrow(/exceeds/i);
  });

  it("returns the buffer for a file within the size cap", async () => {
    const smallBuf = new ArrayBuffer(10);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(getFileResponse("photos/file_1.jpg"))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-length": "10" }),
        arrayBuffer: vi.fn().mockResolvedValue(smallBuf),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("TOKEN");
    const buf = await client.getFileBuffer("F1");
    expect(buf.byteLength).toBe(10);
  });
});
