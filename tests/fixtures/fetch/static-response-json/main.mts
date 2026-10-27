// Response.json(data, init): ResponseInit converts, the data serializes with
// JSON.stringify (TypeError when it answers undefined), then the response
// initializes like the constructor, defaulting content-type to
// application/json.
function show(label: string, make: () => Response): void {
  try {
    const r = make();
    console.log(label, r.status, JSON.stringify(r.statusText), r.headers.get("content-type"), r.headers.get("x-a"));
  } catch (e) {
    console.log(label, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}
show("plain", () => Response.json({ ok: true }));
show("init", () => Response.json([1, 2], { status: 201, statusText: "Made", headers: { "x-a": "1" } }));
show("content-type", () => Response.json("s", { headers: { "content-type": "text/x" } }));
show("headers object", () => Response.json(null, { headers: new Headers([["x-a", "h"]]) }));
show("undefined", () => Response.json(undefined));
const fn: unknown = () => 1;
show("function", () => Response.json(fn));
show("range", () => Response.json({}, { status: 99 }));
show("undefined before range", () => Response.json(undefined, { status: 99 }));
show("null body status", () => Response.json({}, { status: 204 }));
show("bad header", () => Response.json({}, { headers: { "bad name": "x" } }));
show("undefined before bad header", () => Response.json(undefined, { headers: { "bad name": "x" } }));
show("bad statusText", () => Response.json({}, { statusText: "a\nb" }));
const data: unknown = JSON.parse('{"a":[1,"x",null],"n":{"deep":true}}');
const r = Response.json({ data, d: new Date(0), skip: undefined });
console.log(r.bodyUsed, await r.text(), r.bodyUsed);
const parsed: unknown = await Response.json({ round: [1, 2] }).json();
console.log(JSON.stringify(parsed));
