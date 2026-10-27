// undici's DiagnosticsChannel message types (types/diagnostics-channel.d.ts).
import type { Socket } from "node:net";
import type { Connector } from "./types.ts";

export declare namespace DiagnosticsChannel {
  interface Request {
    origin?: string | URL;
    completed: boolean;
    method?: string;
    path: string;
    headers: string | string[];
    addHeader(key: string, value: string): Request;
  }
  interface Response {
    statusCode: number;
    statusText: string;
    headers: Array<Buffer>;
  }
  type Error = unknown;
  interface ConnectParams {
    host: string;
    hostname: string;
    protocol: string;
    port: string;
    servername: string | null;
  }
  type Connector = import("./types.ts").Connector;
  interface RequestCreateMessage {
    request: Request;
  }
  interface RequestBodySentMessage {
    request: Request;
  }
  interface RequestHeadersMessage {
    request: Request;
    response: Response;
  }
  interface RequestTrailersMessage {
    request: Request;
    trailers: Array<Buffer>;
  }
  interface RequestErrorMessage {
    request: Request;
    error: Error;
  }
  interface ClientSendHeadersMessage {
    request: Request;
    headers: string;
    socket: Socket;
  }
  interface ClientBeforeConnectMessage {
    connectParams: ConnectParams;
    connector: Connector;
  }
  interface ClientConnectedMessage {
    socket: Socket;
    connectParams: ConnectParams;
    connector: Connector;
  }
  interface ClientConnectErrorMessage {
    error: Error;
    socket: Socket;
    connectParams: ConnectParams;
    connector: Connector;
  }
}

export type { Connector };
