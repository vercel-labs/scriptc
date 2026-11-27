// The Response surface a real program reads: type (default, error, basic),
// the Response.error() and Response.redirect() statics with their
// validation, the header guards that make response headers immutable, and
// the invalid Request method TypeError.
const error = Response.error();
console.log(
  "error",
  error.type,
  error.status,
  JSON.stringify(error.statusText),
  error.ok,
  error.body,
  JSON.stringify(error.url),
  error.redirected,
  error.bodyUsed,
  JSON.stringify([...error.headers]),
);
console.log("error text", JSON.stringify(await error.text()), error.clone().type);
try {
  error.headers.set("x", "1");
} catch (caught) {
  console.log("error headers", caught.constructor.name, caught.message);
}

const redirect = Response.redirect("https://example.com/x?q=1#f", 307);
console.log(
  "redirect",
  redirect.type,
  redirect.status,
  JSON.stringify(redirect.statusText),
  redirect.headers.get("location"),
  JSON.stringify(redirect.url),
  redirect.body,
  redirect.redirected,
);
console.log("redirect default", Response.redirect("https://example.com/y").status);
try {
  Response.redirect("/relative");
} catch (caught) {
  console.log("redirect relative", caught.constructor.name, caught.message);
}
try {
  Response.redirect("https://example.com/", 200);
} catch (caught) {
  console.log("redirect bad status", caught.constructor.name, caught.message);
}
try {
  Response.redirect("https://example.com/", Number("abc"));
} catch (caught) {
  console.log("redirect nan", caught.constructor.name, caught.message);
}
console.log("redirect truncation", Response.redirect("https://example.com/", 302.9).status);

for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 309, 399]) {
  try {
    console.log("status", status, Response.redirect("https://example.com/", status).status);
  } catch (caught) {
    console.log("status", status, caught.constructor.name, caught.message);
  }
}

// All argument expressions evaluate in source order first; then the url
// converts to a string and the status to a number before the url parses.
const order = [];
try {
  Response.redirect(
    {
      toString() {
        order.push("url");
        return "bad url";
      },
    },
    {
      valueOf() {
        order.push("status");
        return 200;
      },
    },
    (order.push("extra"), 0),
  );
} catch (caught) {
  console.log("argument order", JSON.stringify(order), caught.constructor.name, caught.message);
}
try {
  redirect.headers.set("x", "1");
} catch (caught) {
  console.log("redirect headers", caught.constructor.name, caught.message);
}

console.log("constructed type", new Response("x").type, Response.json({ a: 1 }).type);

try {
  new Request("https://example.com/", { method: "BAD METHOD" });
} catch (caught) {
  console.log("bad method", caught.constructor.name, caught.message);
}

const h = new Headers();
h.append("set-cookie", "a=1");
h.append("Set-Cookie", "b=2");
console.log("getSetCookie", JSON.stringify(h.getSetCookie()), JSON.stringify(h.get("set-cookie")));
h.delete("set-cookie");
console.log("getSetCookie empty", JSON.stringify(h.getSetCookie()));

const fetched = await fetch("data:text/plain,hello");
console.log("fetched type", fetched.type, fetched.status, await fetched.text());
try {
  fetched.headers.set("x", "1");
} catch (caught) {
  console.log("fetched headers", caught.constructor.name, caught.message);
}
