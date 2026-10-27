// undici's error classes (lib/core/errors.js), shared by the 5.x and 7.x
// entries. Names, messages and codes are undici's; the 7.x-only classes are
// exported by the 7.x entry alone.

export interface SocketInfo {
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
  remoteFamily?: string;
  timeout?: number;
  bytesWritten?: number;
  bytesRead?: number;
}

export class UndiciError extends Error {
  code: string;
  constructor(message?: string) {
    super(message);
    this.name = "UndiciError";
    this.code = "UND_ERR";
  }
}

export class ConnectTimeoutError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "ConnectTimeoutError";
    this.message = message || "Connect Timeout Error";
    this.code = "UND_ERR_CONNECT_TIMEOUT";
  }
}

export class HeadersTimeoutError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "HeadersTimeoutError";
    this.message = message || "Headers Timeout Error";
    this.code = "UND_ERR_HEADERS_TIMEOUT";
  }
}

export class HeadersOverflowError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "HeadersOverflowError";
    this.message = message || "Headers Overflow Error";
    this.code = "UND_ERR_HEADERS_OVERFLOW";
  }
}

export class BodyTimeoutError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "BodyTimeoutError";
    this.message = message || "Body Timeout Error";
    this.code = "UND_ERR_BODY_TIMEOUT";
  }
}

export class InvalidArgumentError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidArgumentError";
    this.message = message || "Invalid Argument Error";
    this.code = "UND_ERR_INVALID_ARG";
  }
}

export class InvalidReturnValueError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidReturnValueError";
    this.message = message || "Invalid Return Value Error";
    this.code = "UND_ERR_INVALID_RETURN_VALUE";
  }
}

/** 7.x's base of RequestAbortedError (5.x has no AbortError export; its
 * RequestAbortedError extends UndiciError directly, which no 5.x program can
 * observe through the exported classes). */
export class AbortError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "AbortError";
    this.message = message || "The operation was aborted";
    this.code = "UND_ERR_ABORT";
  }
}

export class RequestAbortedError extends AbortError {
  constructor(message?: string) {
    super(message);
    this.name = "AbortError";
    this.message = message || "Request aborted";
    this.code = "UND_ERR_ABORTED";
  }
}

export class InformationalError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "InformationalError";
    this.message = message || "Request information";
    this.code = "UND_ERR_INFO";
  }
}

export class RequestContentLengthMismatchError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "RequestContentLengthMismatchError";
    this.message = message || "Request body length does not match content-length header";
    this.code = "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH";
  }
}

export class ResponseContentLengthMismatchError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "ResponseContentLengthMismatchError";
    this.message = message || "Response body length does not match content-length header";
    this.code = "UND_ERR_RES_CONTENT_LENGTH_MISMATCH";
  }
}

export class ClientDestroyedError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "ClientDestroyedError";
    this.message = message || "The client is destroyed";
    this.code = "UND_ERR_DESTROYED";
  }
}

export class ClientClosedError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "ClientClosedError";
    this.message = message || "The client is closed";
    this.code = "UND_ERR_CLOSED";
  }
}

export class SocketError extends UndiciError {
  socket: SocketInfo | null;
  constructor(message?: string, socket?: SocketInfo | null) {
    super(message);
    this.name = "SocketError";
    this.message = message || "Socket error";
    this.code = "UND_ERR_SOCKET";
    this.socket = socket ?? null;
  }
}

export class NotSupportedError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "NotSupportedError";
    this.message = message || "Not supported error";
    this.code = "UND_ERR_NOT_SUPPORTED";
  }
}

export class BalancedPoolMissingUpstreamError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "MissingUpstreamError";
    this.message = message || "No upstream has been added to the BalancedPool";
    this.code = "UND_ERR_BPL_MISSING_UPSTREAM";
  }
}

export class HTTPParserError extends Error {
  code: string | undefined;
  data: string | undefined;
  constructor(message?: string, code?: string, data?: string) {
    super(message);
    this.name = "HTTPParserError";
    this.code = code ? `HPE_${code}` : undefined;
    this.data = data ? data : undefined;
  }
}

export class ResponseExceededMaxSizeError extends UndiciError {
  constructor(message?: string) {
    super(message);
    this.name = "ResponseExceededMaxSizeError";
    this.message = message || "Response content exceeded max size";
    this.code = "UND_ERR_RES_EXCEEDED_MAX_SIZE";
  }
}

/** 5.x only (throwOnError). */
export class ResponseStatusCodeError extends UndiciError {
  body: unknown;
  status: number;
  statusCode: number;
  headers: Record<string, string | string[]> | null;
  constructor(
    message?: string,
    statusCode?: number,
    headers?: Record<string, string | string[]> | null,
    body?: unknown,
  ) {
    super(message);
    this.name = "ResponseStatusCodeError";
    this.message = message || "Response Status Code Error";
    this.code = "UND_ERR_RESPONSE_STATUS_CODE";
    this.body = body;
    this.status = statusCode ?? 0;
    this.statusCode = statusCode ?? 0;
    this.headers = headers ?? null;
  }
}

/** 7.x only. */
export class RequestRetryError extends UndiciError {
  statusCode: number;
  data: { count: number };
  headers: Record<string, string | string[]>;
  constructor(
    message: string,
    code: number,
    options: { headers?: Record<string, string | string[]>; data?: { count: number } },
  ) {
    super(message);
    this.name = "RequestRetryError";
    this.message = message || "Request retry error";
    this.code = "UND_ERR_REQ_RETRY";
    this.statusCode = code;
    this.data = options.data ?? { count: 0 };
    this.headers = options.headers ?? {};
  }
}

/** 7.x only. */
export class ResponseError extends UndiciError {
  statusCode: number;
  body: unknown;
  headers: Record<string, string | string[]> | null;
  constructor(
    message: string,
    code: number,
    options: { headers?: Record<string, string | string[]> | null; body?: unknown },
  ) {
    super(message);
    this.name = "ResponseError";
    this.message = message || "Response error";
    this.code = "UND_ERR_RESPONSE";
    this.statusCode = code;
    this.body = options.body;
    this.headers = options.headers ?? null;
  }
}
