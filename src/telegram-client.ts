export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramApi {
  getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void>;
  getFileBuffer(fileId: string): Promise<Buffer>;
}

// Abort a non-long-poll request that hangs this long (undici's default is ~5 min).
const REQUEST_TIMEOUT_MS = 20_000;

export class TelegramClient implements TelegramApi {
  constructor(private token: string) {}

  private base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  /** Parse a Telegram response, distinguishing HTTP-level failures (possibly HTML) from API errors. */
  private async parse<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) {
      let detail = String(res.status);
      try {
        const b = (await res.json()) as { description?: string };
        detail = b?.description ?? detail;
      } catch {
        // Non-JSON error body (e.g. a proxy's HTML 502) — the status is all we have.
      }
      throw new Error(`${what} HTTP ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`${what} failed: ${body.description ?? "unknown error"}`);
    return body.result as T;
  }

  /** fetch with a timeout and a single retry that honors Telegram's 429 retry_after. */
  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 && attempt === 0) {
        let retryAfter = 1;
        try {
          const b = (await res.clone().json()) as { parameters?: { retry_after?: number } };
          retryAfter = Number(b?.parameters?.retry_after) || 1;
        } catch {
          // fall back to a 1s wait
        }
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      return res;
    }
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    const url =
      `${this.base()}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}` +
      `&allowed_updates=${encodeURIComponent('["message"]')}`;
    // Long-poll: allow the server's full timeout plus slack before aborting.
    const res = await this.request(url, {}, (timeoutSeconds + 15) * 1000);
    return this.parse<TgUpdate[]>(res, "getUpdates");
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const res = await this.request(
      `${this.base()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
      REQUEST_TIMEOUT_MS,
    );
    await this.parse(res, "sendMessage");
  }

  async sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("photo", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "result.jpg");
    const res = await this.request(`${this.base()}/sendPhoto`, { method: "POST", body: form }, REQUEST_TIMEOUT_MS);
    await this.parse(res, "sendPhoto");
  }

  async getFileBuffer(fileId: string): Promise<Buffer> {
    const res = await this.request(
      `${this.base()}/getFile?file_id=${encodeURIComponent(fileId)}`,
      {},
      REQUEST_TIMEOUT_MS,
    );
    const file = await this.parse<{ file_path: string }>(res, "getFile");
    const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!dl.ok) throw new Error(`file download failed: HTTP ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }
}
