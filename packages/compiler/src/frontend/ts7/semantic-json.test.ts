import { expect, test } from "vitest";
import {
  checkSemanticJsonStrings,
  decodeSemanticObject,
  decodeSemanticObjects,
  parseSemanticJson,
} from "./semantic-json.js";

test("semantic JSON preserves ordinary strings, escaped slashes, quotes, pairs and nulls", () => {
  const values = [
    "",
    "\uFEFFhéllo 🌍",
    "\\ud800",
    'quoted "\\ud800"',
    "\ud800\udc00",
    "\udbff\udfff",
    "\\",
    null,
  ];
  for (const value of values) {
    const json = JSON.stringify({ value });
    expect(parseSemanticJson(json)).toEqual({ value });
    expect(() => checkSemanticJsonStrings(json, false)).not.toThrow();
  }
  for (const json of ['"\\ud800\\udc00"', '"\\uDBFF\\uDFFF"', '{"\\uD800\\uDC00":"ok"}']) {
    expect(() => checkSemanticJsonStrings(json, false)).not.toThrow();
    expect(parseSemanticJson(json)).toEqual(JSON.parse(json));
  }
});

test("all lone code units remain exact on Node and are refused at the native boundary", () => {
  for (let unit = 0xd800; unit <= 0xdfff; unit++) {
    const text = String.fromCharCode(unit);
    for (const value of [text, { [text]: "key", value: text }, [text, "after"]]) {
      const json = JSON.stringify(value);
      expect(parseSemanticJson(json)).toEqual(value);
      expect(() => checkSemanticJsonStrings(json, false)).toThrow(
        "cannot preserve lone UTF-16 surrogates",
      );
    }
  }
});

test("backslash parity and separated surrogate escapes cannot bypass the boundary", () => {
  for (let count = 1; count <= 8; count++) {
    const json = '"' + "\\".repeat(count) + 'ud800"';
    if (count % 2 === 0) expect(() => checkSemanticJsonStrings(json, false)).not.toThrow();
    else expect(() => checkSemanticJsonStrings(json, false)).toThrow("cannot preserve");
  }
  for (const json of [
    '"\\ud800x\\udc00"',
    '["\\ud800","\\udc00"]',
    '"\\ud800\\ud800"',
    '"\\udc00\\ud800"',
  ]) {
    expect(() => checkSemanticJsonStrings(json, false)).toThrow("cannot preserve");
  }
});

test("malformed JSON remains a parse error rather than an accepted response", () => {
  for (const json of ['"\\uZZZZ"', '"\\uD8"', '"unclosed', '{"value":}', "undefined"]) {
    expect(() => parseSemanticJson(json)).toThrow(SyntaxError);
  }
});

const replyBytes = (json: string): Uint8Array => Buffer.from(json, "utf8");

test("semantic object replies resolve held ids without decoding them and decode the rest", () => {
  const held = new Map([[7, { from: "held", id: 7 }]]);
  const built: unknown[] = [];
  const build = (data: { id: number }) => {
    built.push(data);
    return { from: "built", id: data.id };
  };
  const reply = JSON.stringify([
    { id: 7, name: "held {not} [read]", declarations: ["1.2./a.ts"] },
    null,
    { id: 8, name: 'a "quoted" \\ name ]}', nested: { id: 1, list: [1, { x: "}" }] } },
    { name: "id last", id: 9 },
  ]);
  expect(decodeSemanticObjects(replyBytes(reply), (id) => held.get(id), build)).toEqual([
    { from: "held", id: 7 },
    null,
    { from: "built", id: 8 },
    { from: "built", id: 9 },
  ]);
  expect(built).toEqual([JSON.parse(reply)[2], JSON.parse(reply)[3]]);
  // The text of a held object is not decoded.
  expect(
    decodeSemanticObjects(
      replyBytes('[{"id":7,"bad":\\ud800}, {"id":7}]'),
      (id) => held.get(id),
      build,
    ),
  ).toEqual([
    { from: "held", id: 7 },
    { from: "held", id: 7 },
  ]);
});

test("semantic object replies accept null, empty and single replies", () => {
  const build = (data: { id: number }) => data.id;
  const none = (): number | undefined => undefined;
  expect(decodeSemanticObjects(replyBytes(""), none, build)).toBeNull();
  expect(decodeSemanticObjects(replyBytes("null"), none, build)).toBeNull();
  expect(decodeSemanticObjects(replyBytes(" [ ] "), none, build)).toEqual([]);
  expect(decodeSemanticObjects(replyBytes('[{"id":3},\n{"id":4}]'), none, build)).toEqual([3, 4]);
  expect(decodeSemanticObject(replyBytes(""), none, build)).toBeNull();
  expect(decodeSemanticObject(replyBytes("null"), none, build)).toBeNull();
  expect(decodeSemanticObject(replyBytes('{"id":12,"name":"x"}'), none, build)).toBe(12);
  expect(decodeSemanticObject(replyBytes('{"id":12}'), (id) => id * 2, build)).toBe(24);
  // Non-ASCII text in a decoded object round-trips.
  expect(
    decodeSemanticObject(
      replyBytes(JSON.stringify({ id: 5, name: "héllo 🌍" })),
      (): string | undefined => undefined,
      (data: { id: number; name: string }) => data.name,
    ),
  ).toBe("héllo 🌍");
});

test("semantic object replies reject malformed JSON", () => {
  const build = (data: { id: number }) => data.id;
  const none = (): number | undefined => undefined;
  for (const json of [
    '[{"id":1}',
    '[{"id":1},]',
    '{"id":1} {"id":2}',
    '[{"id":1} {"id":2}]',
    '"open',
    "nul",
  ])
    expect(() => decodeSemanticObjects(replyBytes(json), none, build)).toThrow();
  for (const json of ['{"id":1', '{"id":1}}', "nul"])
    expect(() => decodeSemanticObject(replyBytes(json), none, build)).toThrow();
});
