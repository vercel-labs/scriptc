import {
  TS7_CALLBACK,
  TS7_CALLBACK_ERROR,
  TS7_CALLBACK_RESPONSE,
  TS7_ERROR,
  TS7_REQUEST,
  TS7_RESPONSE,
  Ts7FrameLimitError,
  Ts7ProtocolError,
  Ts7Wire,
} from "./rpc-wire.js";

export interface Ts7RpcTiming {
  requests: number;
  bytesSent: number;
  bytesReceived: number;
  callbacks: number;
}

interface Ts7Callback {
  invoke: (payload: string) => string;
}

function responseText(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

/** The wire protocol is strictly synchronous and has no request ids. A
 * callback must answer the current request; starting a nested request on
 * that channel would consume the outer response under the wrong call. */
export class Ts7RpcClient {
  private readonly callbacks = new Map<string, Ts7Callback>();
  private requesting = false;
  private closed = false;
  private requests = 0;
  private bytesSent = 0;
  private bytesReceived = 0;
  private callbackCount = 0;

  constructor(private readonly wire: Ts7Wire) {}

  registerCallback(name: string, callback: (payload: string) => string): void {
    if (this.closed) throw new Ts7ProtocolError("client is closed");
    if (this.requesting) throw new Ts7ProtocolError("cannot replace callbacks during a request");
    this.callbacks.set(name, { invoke: callback });
  }

  timing(): Ts7RpcTiming {
    return {
      requests: this.requests,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      callbacks: this.callbackCount,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.clear();
    this.wire.close();
  }

  private call(method: string, payload: Uint8Array): void {
    const callback = this.callbacks.get(method);
    if (callback === undefined) {
      const message = `unknown callback: ${method}`;
      this.wire.write(TS7_CALLBACK_ERROR, method, Buffer.from(message, "utf8"));
      throw new Ts7ProtocolError(message);
    }
    this.callbackCount++;
    let response: string;
    try {
      response = callback.invoke(responseText(payload));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.wire.write(TS7_CALLBACK_ERROR, method, Buffer.from(message, "utf8"));
      throw new Ts7ProtocolError(`callback ${method} failed: ${message}`);
    }
    this.wire.write(TS7_CALLBACK_RESPONSE, method, Buffer.from(response, "utf8"));
  }

  requestBytes(method: string, payload: Uint8Array): Uint8Array {
    if (this.closed) throw new Ts7ProtocolError("client is closed");
    if (this.requesting) throw new Ts7ProtocolError("reentrant requests are not supported");
    this.requesting = true;
    try {
      this.wire.write(TS7_REQUEST, method, payload);
      this.requests++;
      this.bytesSent += payload.length;
      for (;;) {
        const message = this.wire.read();
        if (message.kind === TS7_CALLBACK) {
          this.call(message.method, message.payload);
          continue;
        }
        if (message.kind !== TS7_RESPONSE && message.kind !== TS7_ERROR) {
          throw new Ts7ProtocolError(`unexpected server message ${message.kind}`);
        }
        if (message.method !== method) {
          throw new Ts7ProtocolError(
            `response method mismatch: expected ${method}, received ${message.method}`,
          );
        }
        this.bytesReceived += message.payload.length;
        if (message.kind === TS7_ERROR) {
          // A server error is a complete response. Keep this channel usable
          // for panic-fenced checker batches and subsequent valid requests.
          this.requesting = false;
          const text = responseText(message.payload);
          // An empty payload is a checker failure that stated no reason. It
          // takes the panic shape so the lowering's fences catch it and the
          // crash report anchors it at the source position being checked,
          // rather than surfacing as an empty build error at the entry.
          throw new Error(
            text.trim() === ""
              ? `panic: the TypeScript checker failed answering '${method}' without a message`
              : text,
          );
        }
        return message.payload;
      }
    } catch (error) {
      // A frame the wire read and dropped leaves the channel usable: the
      // caller can ask again in smaller pieces.
      if (this.requesting && !(error instanceof Ts7FrameLimitError)) {
        try {
          this.close();
        } catch {
          /* preserve the request failure */
        }
      }
      throw error;
    } finally {
      this.requesting = false;
    }
  }

  requestText(method: string, payload: string): string {
    return responseText(this.requestBytes(method, Buffer.from(payload, "utf8")));
  }
}
