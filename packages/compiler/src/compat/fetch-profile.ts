/**
 * The engine-free fetch/Web-platform compatibility contract.
 *
 * Keep this data-only: lowering, the shipped surface manifest, and the
 * differential conformance generator all consume the same profile. Its
 * reflected inventory classifies the full selected runtime surface, so
 * unsupported work cannot hide outside the positive allowlists. A Node upgrade
 * is deliberate because Node's bundled Undici version is observable in
 * coercion, error, stream, and transport behavior.
 */

export type FetchCompatFacet =
  | "argument-evaluation"
  | "body-consumption"
  | "callback-order"
  | "callback-this"
  | "error-shape"
  | "identity"
  | "liveness"
  | "missing-arguments"
  | "mutation"
  | "promise-settlement"
  | "property-read"
  | "state-machine"
  | "surplus-arguments"
  | "transport"
  | "webidl-conversion";

export interface FetchCompatEvidence {
  /** Stable scenario id interpreted by the generated differential harness. */
  generated?: string;
  /** Fixture directory below tests/fixtures/fetch. */
  fixture?: string;
}

export interface FetchCompatOperation {
  id: string;
  name: string;
  kind: "constructor" | "function" | "method" | "property" | "static-method";
  facets: readonly FetchCompatFacet[];
  /** The supported call/input subset when the operation is not an entire
   * WebIDL overload family. The manifest publishes this verbatim. */
  scope?: string;
  evidence: readonly FetchCompatEvidence[];
}

export interface FetchCompatOption {
  id: string;
  name: string;
  conversion: string;
  evidence: readonly FetchCompatEvidence[];
}

export type FetchCompatInventoryStatus = "static" | "unsupported" | "out-of-scope";

export type FetchCompatInventoryPlacement =
  | "global"
  | "constructor"
  | "static"
  | "prototype"
  | "prototype-inherited"
  | "prototype-symbol"
  | "dictionary";

/** One public property in the pinned runtime census, or one WebIDL
 * dictionary member observed through its conversion reads. Static rows
 * must resolve to an operation/option above; unsupported rows are the
 * implementation queue; out-of-scope rows make intentional omissions
 * explicit instead of letting absence masquerade as a support claim. */
export interface FetchCompatInventoryEntry {
  id: string;
  owner: string;
  member: string;
  placement: FetchCompatInventoryPlacement;
  status: FetchCompatInventoryStatus;
  code?: "SC2020";
  reason?: string;
}

export interface FetchCompatInventoryExclusion {
  name: string;
  reason: string;
}

export interface FetchCompatInventory {
  /** Globals whose own/public inherited surface is reflected under Node. */
  interfaces: readonly string[];
  /** Public member and WebIDL dictionary census, in oracle order. */
  entries: readonly FetchCompatInventoryEntry[];
  /** Adjacent Web APIs deliberately outside this engine-free slice. */
  excludedInterfaces: readonly FetchCompatInventoryExclusion[];
}

export interface FetchCompatProfile {
  schemaVersion: 1;
  target: {
    node: string;
    undici: string;
  };
  requestInit: readonly FetchCompatOption[];
  responseInit: readonly FetchCompatOption[];
  members: {
    responseReads: readonly string[];
    responseCalls: readonly string[];
    readableStreamReads: readonly string[];
    readableStreamCalls: readonly string[];
  };
  operations: readonly FetchCompatOperation[];
  inventory: FetchCompatInventory;
}

const generated = (scenario: string): FetchCompatEvidence => ({ generated: scenario });
const fixture = (name: string): FetchCompatEvidence => ({ fixture: name });

const staticEntry = (
  id: string,
  owner: string,
  member: string,
  placement: FetchCompatInventoryPlacement,
): FetchCompatInventoryEntry => ({ id, owner, member, placement, status: "static" });

const unsupportedEntry = (
  id: string,
  owner: string,
  member: string,
  placement: FetchCompatInventoryPlacement,
  reason: string,
): FetchCompatInventoryEntry => ({
  id,
  owner,
  member,
  placement,
  status: "unsupported",
  code: "SC2020",
  reason,
});

const outOfScopeEntry = (
  id: string,
  owner: string,
  member: string,
  placement: FetchCompatInventoryPlacement,
  reason: string,
): FetchCompatInventoryEntry => ({
  id,
  owner,
  member,
  placement,
  status: "out-of-scope",
  reason,
});

const widerMemberFence = "the member is outside the native static handle projection";
const typedInterfaceUnsupported = "typed source has no compiler bridge for this interface";
const metadataExclusion =
  "WebIDL brand metadata is observable reflection, not an executable compatibility operation";

function buildFetchCompatProfile() {
  return {
    schemaVersion: 1,
    target: {
      node: "24.22.0",
      undici: "7.29.1",
    },
    requestInit: [
      {
        id: "stdlib.fetch.request-init.method",
        name: "RequestInit.method",
        conversion: "WebIDL ByteString after all call arguments evaluate",
        evidence: [fixture("static-coercion")],
      },
      {
        id: "stdlib.fetch.request-init.headers",
        name: "RequestInit.headers",
        conversion: "Headers, record, or sequence-of-pairs snapshot",
        evidence: [fixture("static"), fixture("static-coercion")],
      },
      {
        id: "stdlib.fetch.request-init.body",
        name: "RequestInit.body",
        conversion: "string, Uint8Array, ReadableStream, or null",
        evidence: [fixture("static"), fixture("static-stream"), fixture("static-coercion")],
      },
      {
        id: "stdlib.fetch.request-init.duplex",
        name: "RequestInit.duplex",
        conversion: "WebIDL enum; 'half' required for streaming bodies",
        evidence: [fixture("static-stream"), fixture("static-coercion")],
      },
      {
        id: "stdlib.fetch.request-init.redirect",
        name: "RequestInit.redirect",
        conversion: "WebIDL enum: follow, error, or manual",
        evidence: [fixture("static"), fixture("static-coercion")],
      },
      {
        id: "stdlib.fetch.request-init.signal",
        name: "RequestInit.signal",
        conversion: "native AbortSignal handle or absent",
        evidence: [fixture("static"), fixture("static-abort-throw")],
      },
    ],
    responseInit: [
      {
        id: "stdlib.response-init.headers",
        name: "ResponseInit.headers",
        conversion: "Headers, record, or sequence-of-pairs snapshot",
        evidence: [fixture("static")],
      },
      {
        id: "stdlib.response-init.status",
        name: "ResponseInit.status",
        conversion: "WebIDL unsigned-short conversion followed by the 200–599 range check",
        evidence: [fixture("static")],
      },
      {
        id: "stdlib.response-init.statusText",
        name: "ResponseInit.statusText",
        conversion: "WebIDL ByteString with HTTP reason-phrase validation",
        evidence: [fixture("static")],
      },
    ],
    members: {
      responseReads: [
        "ok",
        "status",
        "statusText",
        "url",
        "redirected",
        "headers",
        "body",
        "bodyUsed",
      ],
      responseCalls: ["json", "text", "bytes"],
      readableStreamReads: ["locked"],
      readableStreamCalls: ["cancel", "getReader"],
    },
    operations: [
      {
        id: "stdlib.headers.constructor",
        name: "Headers constructor",
        kind: "constructor",
        facets: ["webidl-conversion", "mutation", "identity"],
        scope: "Record and iterable header pairs, including copying native Headers",
        evidence: [fixture("static-request")],
      },
      {
        id: "stdlib.request.constructor",
        name: "Request constructor",
        kind: "constructor",
        facets: ["webidl-conversion", "body-consumption", "error-shape"],
        scope:
          "Absolute URLs with method, headers, body, duplex, redirect, and signal; other RequestInit members retain explicit fences",
        evidence: [fixture("static-request")],
      },
      ...[
        "method",
        "url",
        "headers",
        "destination",
        "referrer",
        "referrerPolicy",
        "mode",
        "credentials",
        "cache",
        "redirect",
        "integrity",
        "keepalive",
        "isReloadNavigation",
        "isHistoryNavigation",
        "signal",
        "body",
        "bodyUsed",
        "duplex",
      ].map((member): FetchCompatOperation => ({
        id: `stdlib.request.${member}`,
        name: `Request.${member}`,
        kind: "property",
        facets: ["property-read", "state-machine"],
        scope: "Reads on native Requests within the constructor's supported RequestInit subset",
        evidence: [fixture("static-request")],
      })),
      ...["arrayBuffer", "text", "json", "bytes"].map((member): FetchCompatOperation => ({
        id: `stdlib.request.${member}`,
        name: `Request.${member}`,
        kind: "method",
        facets: ["body-consumption", "promise-settlement", "state-machine", "error-shape"],
        evidence: [fixture("static-request")],
      })),
      {
        id: "stdlib.response.constructor",
        name: "Response constructor",
        kind: "constructor",
        facets: ["webidl-conversion", "body-consumption", "state-machine", "error-shape"],
        scope:
          "BodyInit is string, Uint8Array/Buffer, ReadableStream<Uint8Array>, null/undefined, or a checked-dynamic value that follows the supported WebIDL string conversion; ResponseInit is headers/status/statusText",
        evidence: [fixture("static")],
      },
      {
        id: "stdlib.fetch",
        name: "fetch",
        kind: "function",
        facets: [
          "argument-evaluation",
          "webidl-conversion",
          "surplus-arguments",
          "promise-settlement",
          "transport",
          "error-shape",
        ],
        evidence: [fixture("static"), fixture("static-coercion"), fixture("static-network-error")],
      },
      {
        id: "stdlib.abort-controller.constructor",
        name: "AbortController constructor",
        kind: "constructor",
        facets: ["argument-evaluation", "identity", "state-machine", "surplus-arguments"],
        evidence: [fixture("static-controller")],
      },
      {
        id: "stdlib.abort-controller.signal",
        name: "AbortController.signal",
        kind: "property",
        facets: ["identity", "property-read", "state-machine"],
        evidence: [fixture("static-controller")],
      },
      {
        id: "stdlib.abort-controller.abort",
        name: "AbortController.abort",
        kind: "method",
        facets: ["callback-order", "identity", "liveness", "state-machine", "surplus-arguments"],
        evidence: [fixture("static-controller")],
      },
      {
        id: "stdlib.abort-signal.abort",
        name: "AbortSignal.abort",
        kind: "static-method",
        facets: ["identity", "liveness", "surplus-arguments", "property-read"],
        evidence: [generated("webidl-operations"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.abort-signal.any",
        name: "AbortSignal.any",
        kind: "static-method",
        facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "property-read"],
        evidence: [generated("webidl-operations"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.abort-signal.timeout",
        name: "AbortSignal.timeout",
        kind: "static-method",
        facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "error-shape"],
        evidence: [generated("webidl-operations"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.abort-signal.aborted",
        name: "AbortSignal.aborted",
        kind: "property",
        facets: ["property-read"],
        evidence: [generated("webidl-operations")],
      },
      {
        id: "stdlib.abort-signal.reason",
        name: "AbortSignal.reason",
        kind: "property",
        facets: ["identity", "liveness", "property-read"],
        evidence: [generated("webidl-operations"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.abort-signal.onabort",
        name: "AbortSignal.onabort",
        kind: "property",
        facets: ["callback-order", "callback-this", "mutation", "property-read"],
        evidence: [generated("abort-events"), fixture("static-listener-this")],
      },
      {
        id: "stdlib.abort-signal.throw-if-aborted",
        name: "AbortSignal.throwIfAborted",
        kind: "method",
        facets: ["identity", "error-shape"],
        evidence: [generated("webidl-operations"), fixture("static-abort-throw")],
      },
      {
        id: "stdlib.abort-signal.add-event-listener",
        name: "AbortSignal.addEventListener",
        kind: "method",
        facets: ["webidl-conversion", "identity", "callback-order", "callback-this"],
        evidence: [
          generated("abort-events"),
          fixture("static-listener-this"),
          fixture("static-listener-noncallable"),
        ],
      },
      {
        id: "stdlib.abort-signal.remove-event-listener",
        name: "AbortSignal.removeEventListener",
        kind: "method",
        facets: ["webidl-conversion", "identity", "callback-order"],
        evidence: [generated("abort-events"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.abort-signal.dispatch-event",
        name: "AbortSignal.dispatchEvent",
        kind: "method",
        facets: ["callback-order", "callback-this", "error-shape"],
        evidence: [fixture("static-dispatch-throw")],
      },
      {
        id: "stdlib.readable-stream.constructor",
        name: "ReadableStream constructor",
        kind: "constructor",
        facets: ["webidl-conversion", "callback-this", "callback-order", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream-this")],
      },
      {
        id: "stdlib.readable-stream.from",
        name: "ReadableStream.from",
        kind: "static-method",
        facets: ["webidl-conversion", "missing-arguments", "surplus-arguments", "liveness"],
        evidence: [generated("webidl-operations"), generated("stream-traces")],
      },
      {
        id: "stdlib.readable-stream.locked",
        name: "ReadableStream.locked",
        kind: "property",
        facets: ["property-read", "state-machine"],
        evidence: [generated("stream-traces")],
      },
      {
        id: "stdlib.readable-stream.cancel",
        name: "ReadableStream.cancel",
        kind: "method",
        facets: ["identity", "promise-settlement", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream.get-reader",
        name: "ReadableStream.getReader",
        kind: "method",
        facets: ["webidl-conversion", "identity", "state-machine", "error-shape"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-reader.closed",
        name: "ReadableStreamDefaultReader.closed",
        kind: "property",
        facets: ["promise-settlement", "property-read", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-reader.read",
        name: "ReadableStreamDefaultReader.read",
        kind: "method",
        facets: ["identity", "promise-settlement", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-reader.cancel",
        name: "ReadableStreamDefaultReader.cancel",
        kind: "method",
        facets: ["identity", "promise-settlement", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-reader.release-lock",
        name: "ReadableStreamDefaultReader.releaseLock",
        kind: "method",
        facets: ["promise-settlement", "state-machine", "error-shape"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-controller.desired-size",
        name: "ReadableStreamDefaultController.desiredSize",
        kind: "property",
        facets: ["property-read", "state-machine"],
        evidence: [generated("stream-traces")],
      },
      {
        id: "stdlib.readable-stream-default-controller.enqueue",
        name: "ReadableStreamDefaultController.enqueue",
        kind: "method",
        facets: ["identity", "liveness", "state-machine", "error-shape"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-controller.close",
        name: "ReadableStreamDefaultController.close",
        kind: "method",
        facets: ["state-machine", "error-shape"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      {
        id: "stdlib.readable-stream-default-controller.error",
        name: "ReadableStreamDefaultController.error",
        kind: "method",
        facets: ["identity", "promise-settlement", "state-machine"],
        evidence: [generated("stream-traces"), fixture("static-stream")],
      },
      ...["append", "delete", "get", "getSetCookie", "has", "set", "forEach"].map(
        (member): FetchCompatOperation => ({
          id: `stdlib.headers.${member}`,
          name: `Headers.${member}`,
          kind: "method",
          facets:
            member === "forEach"
              ? ["callback-order", "callback-this", "mutation"]
              : member === "get" || member === "has"
                ? ["webidl-conversion", "missing-arguments", "property-read"]
                : ["webidl-conversion", "mutation", "error-shape"],
          evidence: [fixture("static"), fixture("static-coercion")],
        }),
      ),
      ...["ok", "status", "statusText", "url", "redirected", "headers", "body", "bodyUsed"].map(
        (member): FetchCompatOperation => ({
          id: `stdlib.response.${member}`,
          name: `Response.${member}`,
          kind: "property",
          facets: ["property-read"],
          evidence: [fixture("static")],
        }),
      ),
      {
        id: "stdlib.response.static.json",
        name: "Response.json",
        kind: "static-method",
        facets: ["webidl-conversion", "error-shape"],
        scope:
          "data that crosses the checked-dynamic boundary, serialized with JSON.stringify (toJSON hooks included); ResponseInit as for the constructor",
        evidence: [fixture("static-response-json")],
      },
      ...["json", "text", "bytes", "arrayBuffer"].map((member): FetchCompatOperation => ({
        id: `stdlib.response.${member}`,
        name: `Response.${member}`,
        kind: "method",
        facets: ["body-consumption", "promise-settlement", "state-machine", "error-shape"],
        evidence:
          member === "arrayBuffer"
            ? [fixture("static")]
            : [fixture("static"), fixture("static-stream")],
      })),
    ],
    inventory: {
      interfaces: [
        "AbortController",
        "AbortSignal",
        "Headers",
        "Request",
        "Response",
        "ReadableStream",
        "ReadableStreamDefaultReader",
        "ReadableStreamDefaultController",
      ],
      entries: [
        staticEntry("stdlib.fetch", "globalThis", "fetch", "global"),

        staticEntry(
          "stdlib.abort-controller.constructor",
          "AbortController",
          "constructor",
          "constructor",
        ),
        staticEntry("stdlib.abort-controller.signal", "AbortController", "signal", "prototype"),
        staticEntry("stdlib.abort-controller.abort", "AbortController", "abort", "prototype"),
        outOfScopeEntry(
          "stdlib.abort-controller.symbol.toStringTag",
          "AbortController",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        unsupportedEntry(
          "stdlib.abort-signal.constructor",
          "AbortSignal",
          "constructor",
          "constructor",
          "Node exposes the interface object but constructing it throws; the compiler does not preserve that constructor behavior",
        ),
        staticEntry("stdlib.abort-signal.abort", "AbortSignal", "abort", "static"),
        staticEntry("stdlib.abort-signal.timeout", "AbortSignal", "timeout", "static"),
        staticEntry("stdlib.abort-signal.any", "AbortSignal", "any", "static"),
        staticEntry("stdlib.abort-signal.aborted", "AbortSignal", "aborted", "prototype"),
        staticEntry("stdlib.abort-signal.reason", "AbortSignal", "reason", "prototype"),
        staticEntry(
          "stdlib.abort-signal.throw-if-aborted",
          "AbortSignal",
          "throwIfAborted",
          "prototype",
        ),
        staticEntry("stdlib.abort-signal.onabort", "AbortSignal", "onabort", "prototype"),
        staticEntry(
          "stdlib.abort-signal.add-event-listener",
          "AbortSignal",
          "addEventListener",
          "prototype-inherited",
        ),
        staticEntry(
          "stdlib.abort-signal.remove-event-listener",
          "AbortSignal",
          "removeEventListener",
          "prototype-inherited",
        ),
        staticEntry(
          "stdlib.abort-signal.dispatch-event",
          "AbortSignal",
          "dispatchEvent",
          "prototype-inherited",
        ),
        outOfScopeEntry(
          "stdlib.abort-signal.symbol.toStringTag",
          "AbortSignal",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        staticEntry("stdlib.headers.constructor", "Headers", "constructor", "constructor"),
        ...["append", "delete", "get", "has", "set", "getSetCookie"].map((member) =>
          staticEntry(`stdlib.headers.${member}`, "Headers", member, "prototype"),
        ),
        ...["keys", "values", "entries"].map((member) =>
          unsupportedEntry(
            `stdlib.headers.${member}`,
            "Headers",
            member,
            "prototype",
            "native Headers iteration does not yet expose a static iterator handle",
          ),
        ),
        staticEntry("stdlib.headers.forEach", "Headers", "forEach", "prototype"),
        unsupportedEntry(
          "stdlib.headers.symbol.iterator",
          "Headers",
          "[Symbol.iterator]",
          "prototype-symbol",
          "native Headers iteration does not expose an engine-free iterator handle",
        ),
        outOfScopeEntry(
          "stdlib.headers.symbol.toStringTag",
          "Headers",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        staticEntry("stdlib.request.constructor", "Request", "constructor", "constructor"),
        ...[
          "method",
          "url",
          "headers",
          "destination",
          "referrer",
          "referrerPolicy",
          "mode",
          "credentials",
          "cache",
          "redirect",
          "integrity",
          "keepalive",
          "isReloadNavigation",
          "isHistoryNavigation",
          "signal",
          "body",
          "bodyUsed",
          "duplex",
          "clone",
          "blob",
          "arrayBuffer",
          "text",
          "json",
          "formData",
          "bytes",
          "attribute",
        ].map((member) =>
          ["clone", "blob", "formData", "attribute"].includes(member)
            ? unsupportedEntry(
                `stdlib.request.${member}`,
                "Request",
                member,
                "prototype",
                typedInterfaceUnsupported,
              )
            : staticEntry(`stdlib.request.${member}`, "Request", member, "prototype"),
        ),
        outOfScopeEntry(
          "stdlib.request.symbol.toStringTag",
          "Request",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        staticEntry("stdlib.response.constructor", "Response", "constructor", "constructor"),
        staticEntry("stdlib.response.static.json", "Response", "json", "static"),
        ...["error", "redirect"].map((member) =>
          unsupportedEntry(
            `stdlib.response.static.${member}`,
            "Response",
            member,
            "static",
            "Response static constructor-object operations have no compiler lowering",
          ),
        ),
        unsupportedEntry("stdlib.response.type", "Response", "type", "prototype", widerMemberFence),
        ...["url", "redirected", "status", "ok", "statusText", "headers", "body", "bodyUsed"].map(
          (member) => staticEntry(`stdlib.response.${member}`, "Response", member, "prototype"),
        ),
        staticEntry("stdlib.response.arrayBuffer", "Response", "arrayBuffer", "prototype"),
        ...["clone", "blob", "formData"].map((member) =>
          unsupportedEntry(
            `stdlib.response.${member}`,
            "Response",
            member,
            "prototype",
            "the native fetch runtime does not implement this Response operation",
          ),
        ),
        ...["text", "json"].map((member) =>
          staticEntry(`stdlib.response.${member}`, "Response", member, "prototype"),
        ),
        staticEntry("stdlib.response.bytes", "Response", "bytes", "prototype"),
        outOfScopeEntry(
          "stdlib.response.symbol.toStringTag",
          "Response",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        staticEntry(
          "stdlib.readable-stream.constructor",
          "ReadableStream",
          "constructor",
          "constructor",
        ),
        staticEntry("stdlib.readable-stream.from", "ReadableStream", "from", "static"),
        staticEntry("stdlib.readable-stream.locked", "ReadableStream", "locked", "prototype"),
        staticEntry("stdlib.readable-stream.cancel", "ReadableStream", "cancel", "prototype"),
        staticEntry(
          "stdlib.readable-stream.get-reader",
          "ReadableStream",
          "getReader",
          "prototype",
        ),
        ...["pipeThrough", "values"].map((member) =>
          unsupportedEntry(
            `stdlib.readable-stream.${member}`,
            "ReadableStream",
            member,
            "prototype",
            member === "values"
              ? "direct for-await consumption compiles statically; storing or driving the first-class iterator handle is unsupported"
              : "the wider Web Streams graph is outside the native readable-stream slice",
          ),
        ),
        ...["pipeTo", "tee"].map((member) =>
          unsupportedEntry(
            `stdlib.readable-stream.${member}`,
            "ReadableStream",
            member,
            "prototype",
            "this operation is outside the native readable-stream implementation",
          ),
        ),
        unsupportedEntry(
          "stdlib.readable-stream.symbol.asyncIterator",
          "ReadableStream",
          "[Symbol.asyncIterator]",
          "prototype-symbol",
          "direct for-await consumption compiles statically; explicit symbol access and stored iterator handles have no compiler lowering",
        ),
        outOfScopeEntry(
          "stdlib.readable-stream.symbol.toStringTag",
          "ReadableStream",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        unsupportedEntry(
          "stdlib.readable-stream-default-reader.constructor",
          "ReadableStreamDefaultReader",
          "constructor",
          "constructor",
          "reader handles come from ReadableStream.getReader(); the constructor object is unsupported",
        ),
        staticEntry(
          "stdlib.readable-stream-default-reader.read",
          "ReadableStreamDefaultReader",
          "read",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-reader.release-lock",
          "ReadableStreamDefaultReader",
          "releaseLock",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-reader.closed",
          "ReadableStreamDefaultReader",
          "closed",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-reader.cancel",
          "ReadableStreamDefaultReader",
          "cancel",
          "prototype",
        ),
        outOfScopeEntry(
          "stdlib.readable-stream-default-reader.symbol.toStringTag",
          "ReadableStreamDefaultReader",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        unsupportedEntry(
          "stdlib.readable-stream-default-controller.constructor",
          "ReadableStreamDefaultController",
          "constructor",
          "constructor",
          "controller handles come from underlying-source callbacks; the constructor object is unsupported",
        ),
        staticEntry(
          "stdlib.readable-stream-default-controller.desired-size",
          "ReadableStreamDefaultController",
          "desiredSize",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-controller.close",
          "ReadableStreamDefaultController",
          "close",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-controller.enqueue",
          "ReadableStreamDefaultController",
          "enqueue",
          "prototype",
        ),
        staticEntry(
          "stdlib.readable-stream-default-controller.error",
          "ReadableStreamDefaultController",
          "error",
          "prototype",
        ),
        outOfScopeEntry(
          "stdlib.readable-stream-default-controller.symbol.toStringTag",
          "ReadableStreamDefaultController",
          "[Symbol.toStringTag]",
          "prototype-symbol",
          metadataExclusion,
        ),

        ...[
          "body",
          "cache",
          "credentials",
          "dispatcher",
          "duplex",
          "headers",
          "integrity",
          "keepalive",
          "method",
          "mode",
          "priority",
          "redirect",
          "referrer",
          "referrerPolicy",
          "signal",
          "window",
        ].map((member) => {
          const id = `stdlib.fetch.request-init.${member}`;
          const supported = new Set(["body", "duplex", "headers", "method", "redirect", "signal"]);
          return supported.has(member)
            ? staticEntry(id, "RequestInit", member, "dictionary")
            : member === "dispatcher"
              ? unsupportedEntry(
                  id,
                  "RequestInit",
                  member,
                  "dictionary",
                  "custom dispatchers are unsupported; native environment-proxy routing uses NODE_USE_ENV_PROXY",
                )
              : unsupportedEntry(
                  id,
                  "RequestInit",
                  member,
                  "dictionary",
                  "the compiler does not preserve this RequestInit member's conversion or transport behavior",
                );
        }),
        ...["headers", "status", "statusText"].map((member) =>
          staticEntry(`stdlib.response-init.${member}`, "ResponseInit", member, "dictionary"),
        ),
      ],
      excludedInterfaces: [
        {
          name: "Blob/File/FormData bodies",
          reason:
            "fetch request and response bodies do not accept or produce Blob, File, or FormData values",
        },
        {
          name: "WritableStream/TransformStream",
          reason:
            "native support covers readable fetch bodies and the identity `new TransformStream()`; the WritableStream constructor, transformers, and general Web Streams graphs are unsupported",
        },
        {
          name: "Readable byte/BYOB streams",
          reason:
            "the native stream projection currently supports default readers and controllers only",
        },
        {
          name: "EventSource/WebSocket",
          reason: "these are separate protocol clients, not fetch request/response compatibility",
        },
      ],
    },
  } satisfies FetchCompatProfile;
}

let fetchCompatProfile: ReturnType<typeof buildFetchCompatProfile> | undefined;

/** The Node 24 fetch compatibility profile. It is built on the first call,
 * so runs that do not lower a module do not construct it. */
export function node24FetchCompatProfile(): ReturnType<typeof buildFetchCompatProfile> {
  fetchCompatProfile ??= buildFetchCompatProfile();
  return fetchCompatProfile;
}

/** The members the native static fetch handles project. */
export interface StaticFetchMembers {
  responseReads: ReadonlySet<string>;
  responseCalls: ReadonlySet<string>;
  headersCalls: ReadonlySet<string>;
  readableStreamReads: ReadonlySet<string>;
  readableStreamCalls: ReadonlySet<string>;
}

let staticFetchMemberSets: StaticFetchMembers | undefined;

/** The profile's static members as sets, built on the first call. */
export function staticFetchMembers(): StaticFetchMembers {
  if (staticFetchMemberSets !== undefined) return staticFetchMemberSets;
  const profile = node24FetchCompatProfile();
  staticFetchMemberSets = {
    responseReads: new Set(profile.members.responseReads),
    responseCalls: new Set(profile.members.responseCalls),
    headersCalls: new Set(
      profile.inventory.entries
        .filter(
          (entry) =>
            entry.owner === "Headers" &&
            entry.placement === "prototype" &&
            entry.status === "static",
        )
        .map((entry) => entry.member),
    ),
    readableStreamReads: new Set(profile.members.readableStreamReads),
    readableStreamCalls: new Set(profile.members.readableStreamCalls),
  };
  return staticFetchMemberSets;
}
