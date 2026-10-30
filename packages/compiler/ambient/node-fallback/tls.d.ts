/// <reference path="./crypto.d.ts" />
/// <reference path="./net.d.ts" />

/* node:tls — the TLS server slice (scr_tls.c over scr_net.c with the
 * vendored mbedTLS; linked only into using binaries).
 * createServer({ cert, key }, handler) returns a net.Server; the handler
 * is Node's 'secureConnection' — it fires post-handshake with a socket
 * that behaves exactly like a net socket (write/end/destroy/pipe and the
 * data/end/close/error events are the same lowered surface). cert/key
 * are PEM strings or Buffers. Handshake failures tear the socket down
 * without emitting an event, Node's default for 'tlsClientError' with no listener. */
declare module "tls" {
  import { Server as NetServer, Socket } from "net";
  /** tls.Server: a net server whose connections handshake first. */
  export interface Server extends NetServer {
    /* serve `context` to clients whose SNI name matches `hostname` ('*'
     * matches within one label); the newest match wins */
    addContext(hostname: string, context: TlsOptions | SecureContext): void;
    /* new connections serve a context made from `options` */
    setSecureContext(options: TlsOptions): void;
  }
  export interface TlsOptions {
    /* Optional in the DECLARATION only (real Node programs build these
     * literals with every TLS knob): the lowering still requires both —
     * a literal without them fences at the call site. */
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    /* The options-record stance (see http.RequestOptions): every key
     * typechecks; the option walk fences documented-but-unlowered keys
     * by name and drops undocumented ones like Node. */
    [option: string]: unknown;
  }
  export function createServer(
    options: TlsOptions,
    secureConnectionListener?: (socket: TLSSocket) => void,
  ): Server;
  /** TLSSocket — post-handshake it IS a net socket to every lowered
   * member (the mapping collapses it onto the socket kind; the
   * secureConnect/session events ride the shared socket declarations).
   * The TLS extras: authorized/authorizationError answer Node's verify
   * split — authorizationError is the verify-failure CODE STRING
   * (DEPTH_ZERO_SELF_SIGNED_CERT, ...), or null. */
  export interface TLSSocket extends Socket {
    readonly encrypted: true;
    authorized: boolean;
    authorizationError: string | null;
    /* null before the handshake, then the negotiated protocol or false */
    readonly alpnProtocol: string | false | null;
    /* "TLSv1.2" or "TLSv1.3"; null before the handshake and after close */
    getProtocol(): string | null;
    /* OpenSSL's suite name, the IANA name and the suite's version */
    getCipher(): CipherNameAndProtocol;
    /* whether the handshake resumed a cached session */
    isSessionReused(): boolean;
    /* the peer's certificate: {} before the handshake or without one,
     * null once the socket is destroyed; detailed adds issuerCertificate */
    getPeerCertificate(detailed: true): DetailedPeerCertificate;
    getPeerCertificate(detailed?: false): PeerCertificate;
    getPeerCertificate(detailed?: boolean): PeerCertificate | DetailedPeerCertificate;
    /* the certificate this socket serves, the same way */
    getCertificate(): PeerCertificate | object | null;
    /* a new X509Certificate on each call, or undefined without one */
    getPeerX509Certificate(): import("crypto").X509Certificate | undefined;
    getX509Certificate(): import("crypto").X509Certificate | undefined;
  }
  /* A certificate as getPeerCertificate() and X509Certificate's
   * toLegacyObject() answer it: subject and issuer map attribute short
   * names to values, infoAccess its "<method> - <type>" keys to values. */
  export interface PeerCertificate {
    subject: { [attribute: string]: string | string[] };
    issuer: { [attribute: string]: string | string[] };
    subjectaltname?: string;
    infoAccess?: { [key: string]: string[] };
    ca: boolean;
    modulus?: string;
    exponent?: string;
    pubkey?: Buffer;
    bits?: number;
    valid_from: string;
    valid_to: string;
    fingerprint: string;
    fingerprint256: string;
    fingerprint512: string;
    ext_key_usage?: string[];
    serialNumber: string;
    raw: Buffer;
    asn1Curve?: string;
    nistCurve?: string;
  }
  /* getPeerCertificate(true): each certificate links to its issuer; a
   * self-issued root is its own issuerCertificate */
  export interface DetailedPeerCertificate extends PeerCertificate {
    issuerCertificate: DetailedPeerCertificate;
  }

  /** new tls.TLSSocket(socket, options): the server-mode wrap of an open
   * socket (a server connection or an http CONNECT socket). The options
   * record reads at runtime; isServer, cert, key, secureContext,
   * ALPNProtocols, minVersion and maxVersion are implemented. */
  export interface TLSSocketOptions {
    isServer?: boolean;
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    secureContext?: SecureContext;
    ALPNProtocols?: string[] | Uint8Array;
    minVersion?: string;
    maxVersion?: string;
    [option: string]: unknown;
  }
  export const TLSSocket: new (socket: Socket, options: TLSSocketOptions) => TLSSocket;
  export interface CipherNameAndProtocol {
    name: string;
    standardName: string;
    version: string;
  }
  export const DEFAULT_MIN_VERSION: string;
  export const DEFAULT_MAX_VERSION: string;
  /** tls.connect options — the RUNTIME options record (members read at
   * runtime; port/host/socket/rejectUnauthorized/ca/servername are the
   * honestly-implemented set, every other documented member throws the
   * runtime fence — the options-record stance's divergence-66 shape). */
  export interface ConnectionOptions {
    port?: number;
    host?: string;
    /* an open socket to run the client handshake over */
    socket?: Socket;
    rejectUnauthorized?: boolean;
    ca?: string | Uint8Array | ReadonlyArray<string | Uint8Array>;
    servername?: string;
    [option: string]: unknown;
  }
  export function connect(
    options: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
  export function connect(
    port: number,
    options?: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
  export function connect(
    port: number,
    host?: string,
    options?: ConnectionOptions,
    secureConnectListener?: () => void,
  ): TLSSocket;
  /** An opaque parsed cert/key pair — what an SNI callback answers with
   * (the value is a runtime handle; the members are runtime-internal). */
  export interface SecureContext {}
  /* @types/node's name for createSecureContext's options */
  export type SecureContextOptions = TlsOptions;
  export function createSecureContext(options: TlsOptions): SecureContext;
  /** The CA-store introspection surface (scr_tls_ca.c): per-type cached
   * PEM string arrays. The host bundle stands in for Node's compiled-in
   * Mozilla roots ('bundled', and rootCertificates) AND the platform
   * store ('system') — the Windows certificate stores or POSIX bundle probe;
   * 'extra' reads NODE_EXTRA_CA_CERTS. An unknown type string throws
   * Node's ERR_INVALID_ARG_VALUE TypeError. */
  export function getCACertificates(type?: string): string[];
  export const rootCertificates: readonly string[];
  /** Replaces the 'default' set (deduped) and the trust anchors the TLS
   * client verifies against; a certificate-free non-empty array throws
   * Node's ERR_CRYPTO_OPERATION_FAILED Error. */
  export function setDefaultCACertificates(certs: readonly string[]): void;
}

declare module "node:tls" {
  export * from "tls";
}
