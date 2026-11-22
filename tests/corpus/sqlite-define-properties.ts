// Object.defineProperty and Reflect.defineProperty over node:sqlite's
// objects: a class accessor keeps Node's identity rule ("Cannot redefine
// property"), an added property takes ordinary attributes (non-enumerable
// by default), accessors become real getters, a limit applies a value
// through the limit's setter, and Reflect answers a boolean.
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const stmt = db.prepare("SELECT 1 AS a");
const tag = db.createTagStore(2);

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, "ok", JSON.stringify(run()) ?? "undefined");
  } catch (error) {
    const e = error as { name: string; code?: string; message: string };
    console.log(label, "ERR", e.name, e.code, e.message);
  }
}

const dbFields = db as unknown as Record<string, unknown>;
const stmtFields = stmt as unknown as Record<string, unknown>;
const tagFields = tag as unknown as Record<string, unknown>;
const limitsFields = db.limits as unknown as Record<string, unknown>;

attempt("define-default", () => {
  Object.defineProperty(db, "added", { value: 1 });
  return [dbFields.added, Object.getOwnPropertyDescriptor(db, "added")];
});
attempt("added-keys", () => [Object.keys(db), Object.getOwnPropertyNames(db)]);
attempt("added-json", () => JSON.parse(JSON.stringify(db)));
attempt("added-for-in", () => {
  const seen: string[] = [];
  for (const key in db) {
    if (key === "isOpen" || key === "added" || key === "extra") seen.push(key);
  }
  return seen;
});
attempt("redefine-nonconfigurable", () => Object.defineProperty(db, "added", { enumerable: true }));
attempt("define-configurable", () => {
  Object.defineProperty(db, "extra", { value: 2, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(db, "extra", { value: 3 });
  return [dbFields.extra, Object.getOwnPropertyDescriptor(db, "extra")];
});
attempt("delete-configurable", () => {
  delete dbFields.extra;
  return Object.getOwnPropertyNames(db).includes("extra");
});
attempt("define-accessor", () => {
  Object.defineProperty(db, "computed", {
    get() {
      return 42;
    },
    enumerable: true,
  });
  return [dbFields.computed, Object.getOwnPropertyDescriptor(db, "computed")];
});
attempt("accessor-json", () => JSON.parse(JSON.stringify(db)).computed);
attempt("accessor-keys", () => Object.keys(db));
attempt("redefine-class-value", () => Object.defineProperty(db, "isOpen", { value: true }));
const isOpenGetter = Object.getOwnPropertyDescriptor(db, "isOpen")!.get!;
attempt("redefine-class-same", () => {
  Object.defineProperty(db, "isOpen", { get: isOpenGetter });
  return "same";
});
attempt("redefine-class-empty", () => {
  Object.defineProperty(db, "isTransaction", {});
  return "unchanged";
});
const isTransactionGetter = Object.getOwnPropertyDescriptor(db, "isTransaction")!.get!;
attempt("redefine-class-unchanged", () => {
  Object.defineProperty(db, "isTransaction", {
    get: isTransactionGetter,
    set: undefined,
    enumerable: true,
    configurable: false,
  });
  return "unchanged";
});
attempt("redefine-class-configurable", () =>
  Object.defineProperty(db, "isTransaction", { configurable: true }),
);
attempt("redefine-class-setter", () =>
  Object.defineProperty(db, "isTransaction", { set: (_value: unknown) => undefined }),
);
attempt("redefine-class-hidden", () =>
  Object.defineProperty(db, "isOpen", { get: isOpenGetter, enumerable: false }),
);
attempt("reflect-define", () => Reflect.defineProperty(db, "reflected", { value: 9, enumerable: true }));
attempt("reflect-read", () => dbFields.reflected);
attempt("stmt-define", () => {
  Object.defineProperty(stmt, "note", { value: "n", enumerable: true });
  return stmtFields.note;
});
attempt("tag-define", () => {
  Object.defineProperty(tag, "marked", { value: 5, enumerable: true });
  return tagFields.marked;
});
attempt("limits-define", () => {
  Object.defineProperty(db.limits, "tagged", { value: 7, enumerable: true });
  return limitsFields.tagged;
});
attempt("limits-redacted", () =>
  JSON.parse(
    JSON.stringify(db.limits, (key: string, value: unknown) => (key === "tagged" ? undefined : value)),
  ),
);
attempt("limits-allowlist", () => JSON.parse(JSON.stringify(db.limits, ["length", "column"])));
attempt("limits-nested", () => {
  const drop = (key: string, value: unknown): unknown => (key === "tagged" ? undefined : value);
  return JSON.parse(JSON.stringify({ limits: { inner: db.limits } }, drop));
});
attempt("limits-array", () => {
  const drop = (key: string, value: unknown): unknown => (key === "tagged" ? undefined : value);
  return JSON.parse(JSON.stringify([db.limits], drop));
});
attempt("limits-returned-by-replacer", () => {
  const holder = { value: 1 };
  return JSON.parse(
    JSON.stringify(holder, (key: string, value: unknown) => (key === "value" ? db.limits : value)),
  );
});
attempt("limits-to-json", () => {
  const holder = {
    toJSON() {
      return db.limits;
    },
  };
  return JSON.parse(JSON.stringify(holder, (key: string, value: unknown) => (key === "tagged" ? undefined : value)));
});
attempt("limits-in-added-property", () => {
  const fields = db as unknown as Record<string, unknown>;
  fields.held = db.limits;
  const dropped = JSON.parse(
    JSON.stringify(db, (key: string, value: unknown) => (key === "tagged" ? undefined : value)),
  );
  delete fields.held;
  return dropped.held;
});
attempt("define-limit-value", () => {
  Object.defineProperty(db.limits, "length", { value: 2000000000 });
  return [db.limits.length, Object.getOwnPropertyDescriptor(db.limits, "length")];
});
attempt("define-limit-hidden", () => Object.defineProperty(db.limits, "column", { enumerable: false }));
attempt("empty-descriptor", () => {
  Object.defineProperty(db, "empty", {});
  return Object.getOwnPropertyDescriptor(db, "empty");
});
attempt("delete-empty", () => {
  delete dbFields.empty;
  return Object.getOwnPropertyNames(db).includes("empty");
});

db.close();

// An accessor that removes or replaces itself mid-call keeps its value.
attempt("getter-self-remove", () => {
  const dbx = new DatabaseSync(":memory:");
  const fields = dbx as unknown as Record<string, unknown>;
  Object.defineProperty(dbx, "vanish", {
    get() {
      delete fields.vanish;
      return "kept";
    },
    enumerable: true,
    configurable: true,
  });
  const value = fields.vanish;
  const after = Object.getOwnPropertyNames(dbx).includes("vanish");
  dbx.close();
  return [value, after];
});
attempt("setter-self-replace", () => {
  const dbx = new DatabaseSync(":memory:");
  const fields = dbx as unknown as Record<string, unknown>;
  Object.defineProperty(dbx, "swap", {
    get() {
      return "original";
    },
    set(_value: unknown) {
      Object.defineProperty(dbx, "swap", {
        value: "replaced",
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
    enumerable: true,
    configurable: true,
  });
  fields.swap = 1;
  const value = fields.swap;
  dbx.close();
  return value;
});

// A getter that closes the database mid-walk leaves the walk with Node's
// error instead of reading a closed connection.
attempt("limits-close-in-getter", () => {
  const dbx = new DatabaseSync(":memory:");
  const limits = dbx.limits as unknown as Record<string, unknown>;
  Object.defineProperty(limits, "closer", {
    get() {
      // Removed before the call ends: the accessor closure holds the
      // database, and a handle that still owns it at exit is the separate,
      // documented untraced-cycle leak. The walk itself is unchanged.
      delete limits.closer;
      dbx.close();
      return 1;
    },
    enumerable: true,
    configurable: true,
  });
  return Object.values(limits);
});

// A program-added toJSON is the object's JSON form.
attempt("tojson-db", () => {
  const dbx = new DatabaseSync(":memory:");
  (dbx as unknown as Record<string, unknown>).toJSON = () => ({ tag: "db" });
  const text = JSON.parse(JSON.stringify(dbx));
  dbx.close();
  return text;
});
attempt("tojson-stmt-tag-limits", () => {
  const dbx = new DatabaseSync(":memory:");
  const stmt = dbx.prepare("SELECT 1 AS a");
  const tag = dbx.createTagStore(2);
  const limits = dbx.limits;
  (stmt as unknown as Record<string, unknown>).toJSON = () => ({ tag: "stmt" });
  (tag as unknown as Record<string, unknown>).toJSON = () => ({ tag: "tag" });
  (limits as unknown as Record<string, unknown>).toJSON = () => ({ tag: "limits" });
  const out = [
    JSON.parse(JSON.stringify(stmt)),
    JSON.parse(JSON.stringify(tag)),
    JSON.parse(JSON.stringify(limits)),
    JSON.parse(JSON.stringify({ stmt })),
  ];
  dbx.close();
  return out;
});

// An own property shadows a class method: a function is called, and any
// other value is V8's "not a function" TypeError.
attempt("shadow-method-function", () => {
  const dbx = new DatabaseSync(":memory:");
  let called = false;
  (dbx as unknown as Record<string, unknown>).exec = () => {
    called = true;
  };
  dbx.exec("SELECT 1");
  dbx.close();
  return called;
});
attempt("shadow-method-value", () => {
  const dbx = new DatabaseSync(":memory:");
  (dbx as unknown as Record<string, unknown>).prepare = 5;
  try {
    dbx.prepare("SELECT 1");
    return "none";
  } catch (error) {
    const e = error as { name: string; message: string };
    return [e.name, e.message];
  }
});
