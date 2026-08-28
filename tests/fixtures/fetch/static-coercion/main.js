function methodToString() {
  return this.expected;
}

const method = { expected: "POST", toString: methodToString };
const methodResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method,
  body: "method receiver",
});
const methodResult = await methodResponse.json();
console.log(
  "method coercion receiver:",
  methodResult.method,
  methodResult.body,
);

let headerNameCoercions = 0;
function headerNameToString() {
  headerNameCoercions++;
  return this.expected;
}

const headerName = {
  expected: "content-type",
  toString: headerNameToString,
};
console.log(
  "header name coercion:",
  methodResponse.headers.get(headerName),
  methodResponse.headers.has(headerName),
  headerNameCoercions,
);

function bufferToString() {
  return Buffer.from("POST");
}

function bufferValueOf() {
  throw new Error("valueOf called");
}

try {
  await fetch(`${process.argv[2]}/post-echo`, {
    method: { toString: bufferToString, valueOf: bufferValueOf },
  });
  console.log("object coercion result unexpectedly accepted");
} catch (error) {
  console.log("object coercion result:", error.name, error.message);
}

function duplexToString() {
  return this.expected;
}

const duplex = { expected: "half", toString: duplexToString };
const duplexBody = ReadableStream.from([Buffer.from("duplex body")]);
const duplexResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method: "POST",
  body: duplexBody,
  duplex,
});
const duplexResult = await duplexResponse.json();
console.log("duplex coercion:", duplexResult.method, duplexResult.body);

const plainObjectInit = JSON.parse(
  '{"method":"POST","body":{"answer":42}}',
);
const plainObjectResponse = await fetch(
  `${process.argv[2]}/post-echo`,
  plainObjectInit,
);
const plainObjectResult = await plainObjectResponse.json();
console.log("plain object body coercion:", plainObjectResult.body);

const mutableUrl = new URL(`${process.argv[2]}/text?discarded=1`);
const mutableUrlResponse = await fetch(mutableUrl, {
  method: (mutableUrl.searchParams.delete("discarded"), "GET"),
});
console.log(
  "url conversion after init:",
  mutableUrlResponse.status,
  await mutableUrlResponse.text(),
);

function orderedBodyToString() {
  console.log("request init coercion: body");
  return "ordered body";
}

function orderedDuplexToString() {
  console.log("request init coercion: duplex");
  return "half";
}

function orderedMethodToString() {
  console.log("request init coercion: method");
  return "POST";
}

function orderedRedirectToString() {
  console.log("request init coercion: redirect");
  return "follow";
}

const orderedInitResponse = await fetch(`${process.argv[2]}/post-echo`, {
  method: { toString: orderedMethodToString },
  body: { toString: orderedBodyToString },
  duplex: { toString: orderedDuplexToString },
  redirect: { toString: orderedRedirectToString },
});
const orderedInitResult = await orderedInitResponse.json();
console.log(
  "request init coercion result:",
  orderedInitResult.method,
  orderedInitResult.body,
);

export {};
