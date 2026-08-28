// The engine-free user surface: this is intentionally top-level and has
// no --dynamic directive. Both backends must compile fetch(url),
// RequestInit, and Response.json() into the native net/http/tls runtime.
const constructed = new Response("1");
console.log(
  "constructed response:",
  constructed.status,
  constructed.ok,
  JSON.stringify(constructed.statusText),
  JSON.stringify(constructed.url),
  constructed.redirected,
  constructed.headers.get("content-type"),
  constructed.body !== null,
  constructed.bodyUsed,
  await constructed.text(),
  constructed.bodyUsed,
);

const configuredResponse = new Response(new Uint8Array([104, 105]), {
  status: 201,
  statusText: "Made",
  headers: { "x-one": "one", connection: "custom" },
});
configuredResponse.headers.append("x-one", "two");
configuredResponse.headers.set("x-two", "set");
configuredResponse.headers.delete("x-two");
console.log(
  "configured response:",
  configuredResponse.status,
  configuredResponse.statusText,
  configuredResponse.headers.get("x-one"),
  configuredResponse.headers.get("connection"),
  configuredResponse.headers.has("x-two"),
  await configuredResponse.text(),
);

const responseAsInitSource = new Response("source", {
  status: 203,
  statusText: "Copied",
  headers: { "x-response-init": "yes" },
});
const responseAsInit = new Response(null, responseAsInitSource);
console.log(
  "response as init:",
  responseAsInit.status,
  responseAsInit.statusText,
  responseAsInit.headers.get("x-response-init"),
);

const bodyMutatedResponseInit = {
  status: 201,
  headers: { "x-body-mutated": "before" },
};
const responseInitMutatingBody: any = {
  toString() {
    bodyMutatedResponseInit.status = 202;
    bodyMutatedResponseInit.headers["x-body-mutated"] = "after";
    return "mutated";
  },
};
const responseAfterBodyInitMutation = new Response(
  responseInitMutatingBody,
  bodyMutatedResponseInit,
);
console.log(
  "response init after body conversion:",
  responseAfterBodyInitMutation.status,
  responseAfterBodyInitMutation.headers.get("x-body-mutated"),
);

const spreadResponseHeaders = { "x-spread-live": "before" };
const spreadResponseInit = { headers: spreadResponseHeaders };
const spreadResponseBody: any = {
  toString() {
    spreadResponseHeaders["x-spread-live"] = "after";
    return "spread";
  },
};
const responseWithSpreadInit = new Response(
  spreadResponseBody,
  { ...spreadResponseInit },
);
console.log(
  "response spread init after body conversion:",
  responseWithSpreadInit.headers.get("x-spread-live"),
);

const responseHandleBody: any = new Response();
console.log(
  "response handle body:",
  await new Response(responseHandleBody).text(),
);

class ClassResponseInit {
  status = 202;
  statusText = "Class Made";
  headers = { "x-class-init": "yes" };
}
const classConfiguredResponse = new Response(null, new ClassResponseInit());
console.log(
  "class response init:",
  classConfiguredResponse.status,
  classConfiguredResponse.statusText,
  classConfiguredResponse.headers.get("x-class-init"),
);

const normalizedResponseHeaders = new Response(null, {
  headers: { "X-Mixed-Case": "yes" },
}).headers;
console.log(
  "response header name normalization:",
  normalizedResponseHeaders.get("x-mixed-case"),
  normalizedResponseHeaders.has("X-MIXED-CASE"),
);

const latin1Response = new Response(null, {
  statusText: "é",
  headers: { "x-latin": "é" },
});
latin1Response.headers.append("x-latin", "é");
console.log(
  "response latin1 metadata:",
  JSON.stringify(latin1Response.statusText),
  JSON.stringify(latin1Response.headers.get("x-latin")),
);

const cookieResponseHeaders = new Response().headers;
cookieResponseHeaders.append("cookie", "a");
cookieResponseHeaders.append("cookie", "b");
console.log("response cookie append:", cookieResponseHeaders.get("cookie"));

const deleteDuringForEachHeaders = new Response(null, {
  headers: { a: "1", b: "2", c: "3" },
}).headers;
const deleteDuringForEachSeen: string[] = [];
deleteDuringForEachHeaders.forEach((value, name) => {
  deleteDuringForEachSeen.push(`${name}=${value}`);
  if (name === "a") deleteDuringForEachHeaders.delete("b");
});
console.log(
  "response header forEach delete:",
  deleteDuringForEachSeen.join(","),
);

const appendDuringForEachHeaders = new Response(null, {
  headers: { a: "1", c: "3" },
}).headers;
const appendDuringForEachSeen: string[] = [];
appendDuringForEachHeaders.forEach((value, name) => {
  appendDuringForEachSeen.push(`${name}=${value}`);
  if (name === "a") appendDuringForEachHeaders.append("b", "2");
});
console.log(
  "response header forEach append:",
  appendDuringForEachSeen.join(","),
);

const responseHeaderMutationOrder: string[] = [];
let responseHeaderNameCalls = 0;
const responseHeaderName: any = {
  toString() {
    responseHeaderMutationOrder.push(`name${++responseHeaderNameCalls}`);
    return "x-atomic";
  },
};
const responseHeaderValue: any = {
  toString() {
    responseHeaderMutationOrder.push("value");
    throw new Error("response header value conversion");
  },
};
const atomicResponseHeaders = new Response(null, {
  headers: { "x-atomic": "old" },
}).headers;
try {
  atomicResponseHeaders.set(responseHeaderName, responseHeaderValue);
} catch {}
console.log(
  "response header set failure:",
  responseHeaderMutationOrder.join(","),
  atomicResponseHeaders.get("x-atomic"),
);

const nullResponseHeadersInit: any = { headers: null };
try {
  new Response(null, nullResponseHeadersInit);
  console.log("response null headers unexpectedly accepted");
} catch (error) {
  console.log(
    "response null headers:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}

try {
  new Response(null, { headers: { "bad name": "x" } });
} catch (error) {
  console.log(
    "response invalid header name:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}
try {
  new Response(null, { headers: { x: "bad\nvalue" } });
} catch (error) {
  console.log(
    "response invalid header value:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}
try {
  new Response(null, { headers: { x: "bad\0value" } });
} catch (error) {
  console.log(
    "response nul header value:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}
const shortHeaderPairInit: any = { headers: [["x"]] };
try {
  new Response(null, shortHeaderPairInit);
} catch (error) {
  console.log(
    "response short header pair:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}
try {
  new Response().headers.append("bad name", "x");
} catch (error) {
  console.log(
    "response header mutation validation:",
    (error as Error).name,
    JSON.stringify((error as Error).message),
  );
}

const nullResponse = new Response(null, { status: 204 });
console.log(
  "null response:",
  nullResponse.body === null,
  nullResponse.bodyUsed,
  JSON.stringify(await nullResponse.text()),
  nullResponse.bodyUsed,
);

const streamResponse = new Response(
  ReadableStream.from([
    new Uint8Array([65]),
    new Uint8Array([66]),
  ]),
);
console.log("stream response:", await streamResponse.text());

try {
  new Response("bad", { status: 204 });
} catch (error) {
  console.log("response null-body status:", (error as Error).name);
}
try {
  new Response(null, { status: 199 });
} catch (error) {
  console.log("response status range:", (error as Error).name);
}
try {
  new Response(null, { status: -1e100 });
} catch (error) {
  console.log("response negative status range:", (error as Error).name);
}
console.log(
  "response status conversion:",
  new Response(null, { status: 65736 }).status,
);
const stringStatusInit: any = { status: "201" };
console.log(
  "response string status conversion:",
  new Response(null, stringStatusInit).status,
);

const responseConversionOrder: string[] = [];
const coercibleResponseBody: any = {
  toString() {
    responseConversionOrder.push("body");
    return "ordered";
  },
};
const coercibleResponseInit: any = {
  status: {
    valueOf() {
      responseConversionOrder.push("status");
      return "202";
    },
  },
};
const coercionResponse = new Response(
  coercibleResponseBody,
  coercibleResponseInit,
);
console.log(
  "response coercion order:",
  responseConversionOrder.join(","),
  coercionResponse.status,
  await coercionResponse.text(),
);

const responseInitConversionOrder: string[] = [];
const orderedResponseBody: any = {
  toString() {
    responseInitConversionOrder.push("body");
    return "ordered metadata";
  },
};
const orderedResponseHeader: any = {
  toString() {
    responseInitConversionOrder.push("headers");
    return "value";
  },
};
const orderedResponseStatus: any = {
  valueOf() {
    responseInitConversionOrder.push("status");
    return 202;
  },
};
const orderedResponseStatusText: any = {
  toString() {
    responseInitConversionOrder.push("statusText");
    return "Ordered";
  },
};
const orderedResponseInit = JSON.parse("{}");
orderedResponseInit.headers = JSON.parse("{}");
orderedResponseInit.headers.x = orderedResponseHeader;
orderedResponseInit.status = orderedResponseStatus;
orderedResponseInit.statusText = orderedResponseStatusText;
new Response(orderedResponseBody, orderedResponseInit);
console.log(
  "response init conversion order:",
  responseInitConversionOrder.join(","),
);

const deferredResponseInit: {
  status: number;
  headers: { x: string };
} = { status: 201, headers: { x: "before" } };
const deferredResponse = new Response(
  null,
  deferredResponseInit,
  // @ts-ignore WebIDL ignores surplus constructor arguments.
  (() => {
    deferredResponseInit.status = 202;
    deferredResponseInit.headers.x = "after";
    return "ignored";
  })(),
);
console.log(
  "response deferred init snapshot:",
  deferredResponse.status,
  deferredResponse.headers.get("x"),
);

const lockedResponseBody = new ReadableStream<Uint8Array>();
void lockedResponseBody.getReader();
try {
  new Response(lockedResponseBody, {
    headers: { "bad name": "x" },
    status: 199,
    statusText: "bad\ntext",
  });
} catch (error) {
  console.log(
    "response locked body precedence:",
    (error as Error).name,
    (error as Error).message,
  );
}
const lockedHeaderConversionBody = new ReadableStream<Uint8Array>();
void lockedHeaderConversionBody.getReader();
const throwingResponseHeader: any = {
  toString() {
    throw new Error("response header conversion");
  },
};
const throwingResponseHeaderInit = JSON.parse("{}");
throwingResponseHeaderInit.headers = JSON.parse("{}");
throwingResponseHeaderInit.headers.x = throwingResponseHeader;
try {
  new Response(lockedHeaderConversionBody, throwingResponseHeaderInit);
} catch (error) {
  console.log(
    "response header conversion precedence:",
    (error as Error).name,
    (error as Error).message,
  );
}
try {
  new Response(null, {
    headers: { "bad name": "x" },
    status: 199,
    statusText: "bad\ntext",
  });
} catch (error) {
  console.log("response status precedence:", (error as Error).name);
}
try {
  new Response(null, {
    headers: { "bad name": "x" },
    statusText: "bad\ntext",
  });
} catch (error) {
  console.log(
    "response status text precedence:",
    (error as Error).message,
  );
}
try {
  new Response(null, { statusText: "bad\ntext" });
} catch (error) {
  console.log("response status text:", (error as Error).name);
}

const res = await fetch(`${process.argv[2]}/json`);
console.log(await res.json());

const bracketJson = (await (
  await fetch(`${process.argv[2]}/json`)
)["json"]()) as { n: number };
console.log("bracket json:", bracketJson.n);
console.log(
  "bracket text:",
  await (await fetch(`${process.argv[2]}/text`))["text"](),
);
const bracketBytes = await (
  await fetch(`${process.argv[2]}/text`)
)["bytes"]();
console.log("bracket bytes:", bracketBytes.length, bracketBytes[0]);

function readTextLater(response: Response): Promise<string> {
  return response.text();
}
const pendingText: Promise<string> = readTextLater(
  await fetch(`${process.argv[2]}/text`),
);
console.log("stored text promise:", await pendingText);
const pendingBytes: Promise<Uint8Array> = (
  await fetch(`${process.argv[2]}/text`)
).bytes();
const storedBytes = await pendingBytes;
console.log("stored bytes promise:", storedBytes.length, storedBytes[0]);

async function readComputedBody(
  response: Response,
  asBytes: boolean,
): Promise<string> {
  const member: "text" | "bytes" = asBytes ? "bytes" : "text";
  const value: string | Uint8Array = await response[member]();
  return typeof value === "string"
    ? `text:${value}`
    : `bytes:${value.length}:${value[0]}`;
}
console.log(
  "computed response body:",
  await readComputedBody(await fetch(`${process.argv[2]}/text`), false),
  await readComputedBody(await fetch(`${process.argv[2]}/text`), true),
);

const arityHeaders: any = (await fetch(`${process.argv[2]}/text`)).headers;
try {
  arityHeaders.get();
} catch (error) {
  console.log("headers get arity:", (error as Error).name);
}
try {
  arityHeaders.has();
} catch (error) {
  console.log("headers has arity:", (error as Error).name);
}

const extraArgResponse: any = await fetch(`${process.argv[2]}/text`);
console.log("response text extra arg:", await extraArgResponse.text("ignored"));

const gzipText = await (await fetch(`${process.argv[2]}/gzip`)).text();
console.log(
  "gzip:",
  gzipText.length,
  gzipText.startsWith("compressed héllo 😀"),
  gzipText.endsWith(" "),
);
console.log(
  "deflate:",
  await (await fetch(`${process.argv[2]}/deflate`)).text(),
);
console.log(
  "concatenated gzip:",
  await (await fetch(`${process.argv[2]}/gzip-concat`)).text(),
);
console.log(
  "truncated gzip:",
  JSON.stringify(await (await fetch(`${process.argv[2]}/gzip-truncated`)).text()),
);

const urlResponse = await fetch(new URL(`${process.argv[2]}/json`));
console.log("url:", urlResponse.status);

const headerResponse = await fetch(`${process.argv[2]}/header-echo`, {
  headers: { "x-echo-one": "1", "x-echo-two": "2" },
});
const responseHeaders = headerResponse.headers;
console.log(
  "headers:",
  responseHeaders.get("content-type"),
  responseHeaders.get("x-multi"),
  responseHeaders.get("x-latin"),
  responseHeaders.get("missing") ?? "none",
  responseHeaders.has("x-multi"),
  responseHeaders.has("missing"),
  responseHeaders.getSetCookie().join("|"),
);
responseHeaders.forEach((value, name) => {
  if (name.startsWith("x-")) console.log("header walk:", name, value);
});
responseHeaders.forEach((value, name) => {
  if (name === "x-kind") console.log("header walk thisArg:", name, value);
}, { label: "ignored by the arrow callback" });
try {
  const computedHeaderMember = (): "get" | "has" => "missing" as "get";
  const member = computedHeaderMember();
  responseHeaders[member]("x-kind");
  console.log("computed header member unexpectedly accepted");
} catch (error) {
  console.log("computed header member:", (error as Error).name);
}
await headerResponse.text();

const latin1HeaderResponse = await fetch(`${process.argv[2]}/header-echo`, {
  headers: { "x-echo-one": "é", "x-echo-two": "latin1" },
});
console.log("latin1 request header:", await latin1HeaderResponse.text());

const coercedRecordHeaders: any = {
  "x-echo-one": 123,
  "x-echo-two": false,
};
console.log(
  "coerced record headers:",
  await (
    await fetch(`${process.argv[2]}/header-echo`, {
      headers: coercedRecordHeaders,
    })
  ).text(),
);

const coercedSequenceHeaders: any = [
  ["x-echo-one", 456],
  ["x-echo-two", true],
];
console.log(
  "coerced sequence headers:",
  await (
    await fetch(`${process.argv[2]}/header-echo`, {
      headers: coercedSequenceHeaders,
    })
  ).text(),
);

try {
  await fetch(`${process.argv[2]}/header-echo`, {
    headers: { "x-echo-one": "😀" },
  });
  console.log("wide request header unexpectedly sent");
} catch (error) {
  const caught = error as Error;
  console.log("wide request header:", caught.name);
}

const emptyHeaderResponse = await fetch(`${process.argv[2]}/header-empty`);
console.log(
  "empty duplicate header:",
  JSON.stringify(emptyHeaderResponse.headers["get"]("x-empty")),
);
await emptyHeaderResponse.text();

const headersSource = await fetch(`${process.argv[2]}/headers-source`);
const reusedHeaders = await fetch(`${process.argv[2]}/headers-reuse`, {
  headers: headersSource.headers,
});
console.log("reused headers:", await reusedHeaders.text());

console.log(
  "normalized request headers:",
  await (
    await fetch(`${process.argv[2]}/header-init-echo`, {
      headers: [
        ["X-Duplicate", " one "],
        ["x-duplicate", "\ttwo\t"],
        ["Cookie", "a=1"],
        ["cookie", "b=2"],
      ],
    })
  ).json(),
);

try {
  await fetch(`${process.argv[2]}/text`, {
    headers: [
      ["connection", "close"],
      ["Connection", "keep-alive"],
    ],
  });
  console.log("duplicate connection unexpectedly sent");
} catch (error) {
  const caught = error as Error;
  console.log("duplicate connection:", caught.name, caught.message);
}

console.log(
  "request defaults:",
  await (await fetch(`${process.argv[2]}/request-defaults`)).json(),
);
const forcedFetchMode = (await (
  await fetch(`${process.argv[2]}/request-defaults`, {
    headers: { "sec-fetch-mode": "navigate" },
  })
).json()) as { secFetchMode: string };
console.log("forced sec-fetch-mode:", forcedFetchMode.secFetchMode);
const forcedHost = (await (
  await fetch(`${process.argv[2]}/request-defaults`, {
    headers: { host: "custom.invalid" },
  })
).json()) as { host: string };
console.log(
  "transport-controlled host:",
  forcedHost.host === new URL(process.argv[2]!).host,
);
console.log(
  "raw request headers:",
  await (await fetch(`${process.argv[2]}/raw-headers`)).text(),
);

const forbiddenRequestHeaders: Array<
  [string, Record<string, string>]
> = [
  ["connection", { connection: "x" }],
  ["transfer-encoding", { "transfer-encoding": "chunked" }],
  ["keep-alive", { "keep-alive": "timeout=5" }],
  ["upgrade", { upgrade: "websocket" }],
  ["expect", { expect: "100-continue" }],
];
for (const [name, headers] of forbiddenRequestHeaders) {
  try {
    await fetch(`${process.argv[2]}/text`, { headers });
    console.log("forbidden request header unexpectedly sent:", name);
  } catch (error) {
    const caught = error as Error;
    console.log("forbidden request header:", name, caught.name, caught.message);
  }
}

const init: RequestInit = {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-user-tag": "static",
  },
  body: JSON.stringify({ q: 7 }),
};
const echoed = await fetch(`${process.argv[2]}/post-echo`, init);
console.log(await echoed.json());

const scalarBodyInit = JSON.parse(
  '{"method":"POST","body":123}',
) as RequestInit;
const scalarBodyEcho = await (
  await fetch(`${process.argv[2]}/post-echo`, scalarBodyInit)
).json() as { method: string; contentType: string; body: string };
console.log(
  "coerced scalar body:",
  scalarBodyEcho.method,
  scalarBodyEcho.contentType,
  scalarBodyEcho.body,
);

const scalarMethodInit = JSON.parse('{"method":null}') as RequestInit;
const scalarMethodEcho = await (
  await fetch(`${process.argv[2]}/post-echo`, scalarMethodInit)
).json() as { method: string };
console.log("coerced scalar method:", scalarMethodEcho.method);

// A runtime-computed dictionary cannot be source-profiled, so the native
// RequestInit validator remains the defensive backstop for unsupported keys.
const unsupportedInit = JSON.parse(
  '{"method":"GET","integrity":"sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
) as RequestInit;
try {
  await fetch(`${process.argv[2]}/text`, unsupportedInit);
  console.log("unsupported request init unexpectedly accepted");
} catch (error) {
  const caught = error as Error;
  console.log("unsupported request init:", caught.name, caught.message);
}

const unsupportedThenUndefined = { cache: "no-store" } as const;
const overwrittenUnsupportedInit = {
  ...unsupportedThenUndefined,
  cache: undefined,
} as RequestInit;
const overwrittenUnsupported = await fetch(
  `${process.argv[2]}/text`,
  overwrittenUnsupportedInit,
);
console.log("overwritten unsupported request init:", await overwrittenUnsupported.text());

const matchedLength = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  headers: { "content-length": "2" },
  body: "hi",
});
console.log("matched fixed content-length:", await matchedLength.json());

const redirected = await fetch(`${process.argv[2]}/redirect`);
console.log(
  "redirect:",
  redirected.status,
  redirected.redirected,
  redirected.url.endsWith("/text"),
  await redirected.text(),
);

const backslashRedirect = await fetch(
  `${process.argv[2]}/redirect-backslash`,
);
console.log(
  "backslash redirect:",
  backslashRedirect.status,
  backslashRedirect.url.endsWith("/text"),
  await backslashRedirect.text(),
);

const sameSchemeRedirect = await fetch(
  `${process.argv[2]}/redirect-same-scheme/dir/start`,
);
console.log(
  "same-scheme redirect:",
  sameSchemeRedirect.status,
  sameSchemeRedirect.url.endsWith("/redirect-same-scheme/dir/next"),
  await sameSchemeRedirect.text(),
);

const invalidUtf8Redirect = await fetch(
  `${process.argv[2]}/redirect-invalid-utf8`,
);
console.log(
  "invalid utf8 redirect:",
  invalidUtf8Redirect.url.endsWith("/caf%EF%BF%BD"),
  await invalidUtf8Redirect.text(),
);

const fragmentRedirect = await fetch(
  `${process.argv[2]}/redirect-fragment/path`,
  {
    headers: {
      "x-redirect-key": process.argv[3] ?? "static-fragment",
    },
  },
);
console.log(
  "fragment redirect:",
  fragmentRedirect.status,
  fragmentRedirect.url.endsWith("/redirect-fragment/path"),
  await fragmentRedirect.text(),
);

const manualRedirect = await fetch(`${process.argv[2]}/redirect`, {
  redirect: "manual",
});
console.log(
  "manual redirect:",
  manualRedirect.status,
  manualRedirect.redirected,
  manualRedirect.url.endsWith("/redirect"),
  manualRedirect.headers.get("location"),
  JSON.stringify(await manualRedirect.text()),
);

try {
  await fetch(`${process.argv[2]}/redirect`, { redirect: "error" });
} catch (error) {
  const caught = error as Error;
  console.log("error redirect:", caught.name, caught.message);
}

try {
  await fetch(`${process.argv[2]}/redirect-credentials`);
} catch (error) {
  const caught = error as Error;
  console.log("credential redirect:", caught.name, caught.message);
}

try {
  const credentialUrl =
    `http://user:pass@${process.argv[2].slice("http://".length)}/text`;
  await fetch(credentialUrl);
} catch (error) {
  const caught = error as Error;
  console.log("credential URL:", caught.name, caught.message);
}

console.log(
  "early hints:",
  await (await fetch(`${process.argv[2]}/early-hints`)).text(),
);
try {
  await fetch(`${process.argv[2]}/switching-protocols`);
  console.log("switching protocols unexpectedly resolved");
} catch (error) {
  const caught = error as Error;
  console.log("switching protocols:", caught.name, caught.message);
}
console.log(
  "invalid utf8:",
  JSON.stringify(await (await fetch(`${process.argv[2]}/invalid-utf8`)).text()),
);

const statusMeta = await fetch(`${process.argv[2]}/status-meta`);
console.log("status text:", statusMeta.status, statusMeta.statusText);

const head = await fetch(`${process.argv[2]}/text`, { method: "HEAD" });
console.log(
  "head body:",
  head.body === null,
  head.bodyUsed,
  JSON.stringify(await head.text()),
  head.bodyUsed,
  JSON.stringify(await head.text()),
);
const noContent = await fetch(`${process.argv[2]}/no-content`);
try {
  await noContent.json();
} catch (error) {
  const caught = error as Error;
  console.log("no-content json:", caught.name, caught.message, noContent.bodyUsed);
}
console.log(
  "no-content body:",
  noContent.body === null,
  noContent.bodyUsed,
  JSON.stringify(await noContent.text()),
  noContent.bodyUsed,
);
const resetContent = await fetch(`${process.argv[2]}/reset-content`);
console.log(
  "reset-content body:",
  resetContent.body === null,
  JSON.stringify(await resetContent.text()),
);
const largeResetContent = await fetch(
  `${process.argv[2]}/reset-content-large`,
);
console.log(
  "large reset-content body:",
  largeResetContent.body === null,
  JSON.stringify(await largeResetContent.text()),
);

try {
  await fetch(`${process.argv[2]}/json`, { method: "BAD METHOD" });
} catch (error) {
  console.log("invalid-method:", (error as Error).name);
}
try {
  await fetch("not a url", {
    signal: AbortSignal.abort(new Error("must not mask URL validation")),
  });
} catch (error) {
  console.log("aborted invalid-url:", (error as Error).name);
}
try {
  await fetch(`${process.argv[2]}/text`, { method: "TRACE" });
} catch (error) {
  const caught = error as Error;
  console.log("forbidden-method:", caught.name, caught.message);
}
try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: "POST",
    headers: { "content-length": "5" },
    body: "hi",
    signal: AbortSignal.timeout(200),
  });
} catch (error) {
  const caught = error as Error;
  console.log("fixed content-length mismatch:", caught.name, caught.message);
}
