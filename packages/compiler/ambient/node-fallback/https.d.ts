/// <reference path="./http.d.ts" />

/* node:https — http over the TLS transport (scr_tls.c).
 * createServer({ cert, key }, handler) is the http server behind a
 * handshake; request/get are the http client with port 443 default and
 * the local-CA knobs: `ca` (PEM string/Buffer) replaces the trust
 * anchors, rejectUnauthorized: false disables verification (the
 * self-signed probe shape). With neither, /etc/ssl/cert.pem stands in
 * for Node's bundled roots. */
declare module "https" {
  import { Server } from "http";
  import { Agent, ClientRequest, IncomingMessage, ServerResponse } from "http";
  export { Agent, Server };
  /* Node's keepAlive global agent for requests without an agent option. */
  export const globalAgent: Agent;
  export interface ServerOptions {
    cert: string | Uint8Array;
    key: string | Uint8Array;
    /* The options-record stance (see http.RequestOptions). */
    [option: string]: unknown;
  }
  export interface RequestOptions {
    hostname?: string;
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    timeout?: number;
    headers?: { [name: string]: string };
    rejectUnauthorized?: boolean;
    ca?: string | Uint8Array;
    agent?: Agent | boolean | null;
    /* Aborting destroys the request with an AbortError. */
    signal?: AbortSignal;
    socketPath?: string;
    /* The options-record stance (see http.RequestOptions). */
    [option: string]: unknown;
  }
  export function createServer(
    options: ServerOptions,
    requestListener: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  /* One signature with a union first parameter, for the request-fn
   * ternary's sake (see the http block). A URL target takes no options,
   * which means Node's defaults — the certificate is verified against
   * the default trust anchors. */
  export function request(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function get(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
}

declare module "node:https" {
  export * from "https";
}
