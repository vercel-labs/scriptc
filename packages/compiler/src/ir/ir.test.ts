import { describe, expect, test } from "vitest";

import {
  DYN,
  F64,
  HANDLE_KINDS,
  BYTES_ELEMENT_NAME,
  bytesOf,
  canConvertToDyn,
  canDynCheckTo,
  type IrBytesElem,
  isJsonSafeType,
  iterableArmsElem,
  isJsonStringifySafeType,
  isJsonStringifyDynamicType,
  type IrRecordShape,
  type IrType,
  type IrUnionDef,
  POINTER_KINDS,
  STRING,
  arrayOf,
  typeEquals,
  typeKey,
} from "./ir.js";

describe("iterable unions", () => {
  const gen = (yieldT: IrType): IrType => ({
    kind: "generator",
    yieldT,
    retT: { kind: "void" },
    nextT: { kind: "undefinedT" },
  });

  test("names the element type of an Iterable<T> union", () => {
    expect(iterableArmsElem([arrayOf(F64), gen(F64), { kind: "set", elem: F64 }])).toEqual(F64);
    expect(iterableArmsElem([arrayOf(STRING), gen(STRING), STRING])).toEqual(STRING);
    expect(iterableArmsElem([arrayOf(F64), gen(F64), { kind: "undefinedT" }])).toEqual(F64);
  });

  test("rejects unions without exactly one plain generator arm over the same element", () => {
    expect(iterableArmsElem([arrayOf(F64), STRING])).toBeNull();
    expect(iterableArmsElem([arrayOf(STRING), gen(F64)])).toBeNull();
    expect(iterableArmsElem([arrayOf(F64), gen(F64), gen(STRING)])).toBeNull();
    expect(iterableArmsElem([gen(F64), STRING])).toBeNull();
    expect(iterableArmsElem([arrayOf(F64), { ...gen(F64), nextT: F64 } as IrType])).toBeNull();
  });
});

describe("IR kind sets", () => {
  test("keeps procStream as the scalar handle exception", () => {
    expect(HANDLE_KINDS.has("procStream")).toBe(true);
    expect(POINTER_KINDS.has("procStream")).toBe(false);
    for (const kind of HANDLE_KINDS) {
      if (kind !== "procStream") expect(POINTER_KINDS.has(kind)).toBe(true);
    }
  });

  test("distinguishes pointer values from object-like scalars", () => {
    expect(POINTER_KINDS.has("record")).toBe(true);
    expect(POINTER_KINDS.has("date")).toBe(true);
    expect(POINTER_KINDS.has("procStream")).toBe(false);
  });

  test("distinguishes typed-rest closure ABIs", () => {
    const packed = arrayOf(STRING);
    const typedRest = {
      kind: "func" as const,
      params: [packed],
      ret: STRING,
      rest: true as const,
      restAbi: "typed" as const,
    };
    const fixed = { kind: "func" as const, params: [packed], ret: STRING };
    expect(typeEquals(typedRest, fixed)).toBe(false);
    expect(typeKey(typedRest)).toBe("func(array<string>,...typed[])=>string");
  });

  test("distinguishes full arguments from surplus rest closure ABIs", () => {
    const full = {
      kind: "func" as const,
      params: [STRING],
      ret: STRING,
      rest: true as const,
      argumentsAll: true as const,
    };
    const surplus = { kind: "func" as const, params: [STRING], ret: STRING, rest: true as const };
    expect(typeEquals(full, surplus)).toBe(false);
    expect(typeKey(full)).toBe("func(string,arguments[])=>string");
  });
});

describe("checked records with opaque payloads", () => {
  const records = new Map<string, IrRecordShape>([
    [
      "payload",
      {
        id: "payload",
        fields: [
          { name: "id", type: F64 },
          { name: "value", type: DYN },
        ],
      },
    ],
    [
      "recursive",
      {
        id: "recursive",
        fields: [
          { name: "children", type: arrayOf({ kind: "record", shapeId: "recursive" }) },
          { name: "payload", type: DYN },
        ],
      },
    ],
    [
      "tuple",
      {
        id: "tuple",
        tuple: true,
        fields: [
          { name: "0", type: STRING },
          { name: "1", type: DYN },
        ],
      },
    ],
    [
      "unsafe",
      {
        id: "unsafe",
        fields: [
          { name: "child", type: { kind: "record", shapeId: "unsafe" } },
          { name: "map", type: { kind: "map", key: STRING, value: F64 } },
        ],
      },
    ],
  ]);
  const unions = new Map<string, IrUnionDef>([
    [
      "optional",
      { id: "optional", arms: [{ kind: "record", shapeId: "payload" }, { kind: "undefinedT" }] },
    ],
  ]);
  const record = (id: string): IrRecordShape | undefined => records.get(id);
  const union = (id: string): IrUnionDef | undefined => unions.get(id);

  test.each(["payload", "recursive", "tuple"])(
    "validates %s without declaring opaque slots JSON-safe",
    (id) => {
      const type: IrType = { kind: "record", shapeId: id };
      expect(canDynCheckTo(type, record, union)).toBe(true);
      expect(isJsonSafeType(type, record, union)).toBe(false);
      expect(isJsonStringifySafeType(type, record, union)).toBe(false);
      expect(isJsonStringifyDynamicType(type, record, union)).toBe(true);
    },
  );

  test("opaque arrays and optional records retain their actual payload representation", () => {
    expect(canDynCheckTo(arrayOf(DYN), record, union)).toBe(true);
    expect(canDynCheckTo({ kind: "union", unionId: "optional" }, record, union)).toBe(true);
  });

  test("recursive back-edges cannot hide an unsupported sibling", () => {
    expect(canDynCheckTo({ kind: "record", shapeId: "unsafe" }, record, union)).toBe(false);
    expect(canDynCheckTo({ kind: "record", shapeId: "missing" }, record, union)).toBe(false);
    expect(canDynCheckTo({ kind: "union", unionId: "missing" }, record, union)).toBe(false);
    expect(isJsonStringifyDynamicType({ kind: "record", shapeId: "unsafe" }, record, union)).toBe(
      false,
    );
    expect(isJsonStringifyDynamicType({ kind: "record", shapeId: "missing" }, record, union)).toBe(
      false,
    );
    expect(isJsonStringifyDynamicType({ kind: "union", unionId: "missing" }, record, union)).toBe(
      false,
    );
  });

  test("runtime JSON traversal does not broaden root-undefined or island contracts", () => {
    expect(isJsonStringifyDynamicType({ kind: "union", unionId: "optional" }, record, union)).toBe(
      false,
    );
    expect(isJsonStringifyDynamicType(DYN, record, union)).toBe(false);
    expect(isJsonStringifyDynamicType(arrayOf(DYN), record, union)).toBe(true);
    expect(isJsonStringifyDynamicType(arrayOf(STRING), record, union)).toBe(false);
    expect(
      isJsonStringifyDynamicType(arrayOf({ kind: "union", unionId: "optional" }), record, union),
    ).toBe(true);
  });

  test("class instances stringify through the runtime JSON traversal only", () => {
    const point: IrType = { kind: "object", className: "Point" };
    const failure: IrType = { kind: "object", className: "%Error" };
    expect(isJsonStringifyDynamicType(point, record, union)).toBe(true);
    expect(isJsonStringifyDynamicType(arrayOf(point), record, union)).toBe(true);
    expect(isJsonStringifyDynamicType(failure, record, union)).toBe(false);
    expect(isJsonStringifySafeType(point, record, union)).toBe(false);
    expect(isJsonSafeType(point, record, union)).toBe(false);
    expect(canDynCheckTo(arrayOf(point), record, union)).toBe(true);
  });
});

describe("native typed-array boundaries", () => {
  test.each(Object.keys(BYTES_ELEMENT_NAME) as IrBytesElem[])(
    "preserves %s in checked records without a JSON/island claim",
    (elem) => {
      const view = bytesOf(elem);
      const record = (id: string): IrRecordShape | undefined =>
        id === "views" ? { id, fields: [{ name: "values", type: arrayOf(view) }] } : undefined;
      const union = () => undefined;
      const shape: IrType = { kind: "record", shapeId: "views" };
      expect(canConvertToDyn(shape, record, union)).toBe(true);
      expect(canDynCheckTo(shape, record, union)).toBe(true);
      expect(isJsonSafeType(shape, record, union)).toBe(false);
    },
  );
});

describe("native bigint checked storage", () => {
  test("checks nested bigints without declaring them JSON or island safe", () => {
    const bigint: IrType = { kind: "bigint" };
    const record = (id: string): IrRecordShape | undefined =>
      id === "integers" ? { id, fields: [{ name: "values", type: arrayOf(bigint) }] } : undefined;
    const union = (): IrUnionDef | undefined => undefined;
    for (const type of [
      bigint,
      arrayOf(bigint),
      { kind: "record", shapeId: "integers" } as IrType,
    ]) {
      expect(canConvertToDyn(type, record, union)).toBe(true);
      expect(canDynCheckTo(type, record, union)).toBe(true);
      expect(isJsonSafeType(type, record, union)).toBe(false);
      expect(isJsonStringifySafeType(type, record, union)).toBe(false);
    }
  });
});

describe("native process stream checked storage", () => {
  test("preserves stream fields and union arms without claiming scalar array storage", () => {
    const stream: IrType = { kind: "procStream" };
    const optional: IrType = { kind: "union", unionId: "optionalStream" };
    const record = (id: string): IrRecordShape | undefined =>
      id === "options" ? { id, fields: [{ name: "stream", type: optional }] } : undefined;
    const union = (id: string): IrUnionDef | undefined =>
      id === "optionalStream" ? { id, arms: [stream, { kind: "undefinedT" }] } : undefined;
    for (const type of [
      stream,
      optional,
      { kind: "record", shapeId: "options" } as IrType,
      arrayOf(optional),
    ]) {
      expect(canConvertToDyn(type, record, union)).toBe(true);
      expect(canDynCheckTo(type, record, union)).toBe(true);
      expect(isJsonSafeType(type, record, union)).toBe(false);
    }
    expect(canConvertToDyn(arrayOf(stream), record, union)).toBe(false);
    expect(canDynCheckTo(arrayOf(stream), record, union)).toBe(false);
  });
});

describe("checked conversion graph traversal", () => {
  test.each([
    { label: "boxing", convert: canConvertToDyn },
    { label: "checking", convert: canDynCheckTo },
  ])("$label reuses shared record and union subgraphs", ({ convert }) => {
    const records = new Map<string, IrRecordShape>();
    const unions = new Map<string, IrUnionDef>();
    let type: IrType = { kind: "symbol" };
    for (let i = 0; i < 16; i++) {
      const id = `r${i}`,
        unionId = `u${i}`;
      records.set(id, {
        id,
        fields: [
          { name: "left", type },
          { name: "right", type },
        ],
      });
      unions.set(unionId, {
        id: unionId,
        arms: [{ kind: "record", shapeId: id }, { kind: "undefinedT" }],
      });
      type = { kind: "union", unionId };
    }
    let lookups = 0;
    expect(
      convert(
        type,
        (id) => {
          lookups++;
          return records.get(id);
        },
        (id) => {
          lookups++;
          return unions.get(id);
        },
      ),
    ).toBe(true);
    expect(lookups).toBeLessThan(1000);
  });

  test("failed recursive branches discard dependent conversion results", () => {
    const records = new Map<string, IrRecordShape>([
      [
        "parent",
        {
          id: "parent",
          fields: [
            { name: "child", type: { kind: "record", shapeId: "child" } },
            { name: "unsupported", type: { kind: "caught" } },
          ],
        },
      ],
      [
        "child",
        {
          id: "child",
          fields: [
            { name: "parent", type: { kind: "record", shapeId: "parent" } },
            { name: "symbol", type: { kind: "symbol" } },
          ],
        },
      ],
    ]);
    const visiting = new Set<string>();
    const getRecord = (id: string) => records.get(id);
    expect(
      canConvertToDyn({ kind: "record", shapeId: "parent" }, getRecord, () => undefined, visiting),
    ).toBe(false);
    expect(
      canConvertToDyn({ kind: "record", shapeId: "child" }, getRecord, () => undefined, visiting),
    ).toBe(false);
  });
});
