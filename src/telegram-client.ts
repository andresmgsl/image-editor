export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
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

export class TelegramClient implements TelegramApi {
  constructor(private token: string) {}

  private base(): string {
    return `https://api.telegram.org/bot${this.token}`;
  }

  private async ok<T>(res: Response, what: string): Promise<T> {
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`${what} failed: ${body.description ?? res.status}`);
    return body.result as T;
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TgUpdate[]> {
    const res = await fetch(`${this.base()}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}`);
    return this.ok<TgUpdate[]>(res, "getUpdates");
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const res = await fetch(`${this.base()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    await this.ok(res, "sendMessage");
  }

  async sendPhoto(chatId: number, image: Buffer, caption: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("photo", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "result.jpg");
    const res = await fetch(`${this.base()}/sendPhoto`, { method: "POST", body: form });
    await this.ok(res, "sendPhoto");
  }

  async getFileBuffer(fileId: string): Promise<Buffer> {
    const res = await fetch(`${this.base()}/getFile?file_id=${fileId}`);
    const file = await this.ok<{ file_path: string }>(res, "getFile");
    const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!dl.ok) throw new Error(`file download failed: ${dl.status}`);
    return Buffer.from(await dl.arrayBuffer());
  }
}
