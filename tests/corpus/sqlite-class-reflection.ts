// node:sqlite's objects as ordinary objects: DatabaseSync, StatementSync
// and SQLTagStore list their class accessors first and the properties
// JavaScript added after them, answer Node's accessor descriptors through
// the one shared getter each, serialize through the getters' values, and
// print through util.inspect; a closed database or finalized statement
// keeps its key list and answers the reads' error.
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";

const db = new DatabaseSync(":memory:");
const stmt = db.prepare("SELECT 1 AS a, 'x' AS b");
const store = db.createTagStore(3);
const limits = db.limits;

const show = (label: string, value: unknown): void => {
  console.log(label, JSON.stringify(value));
};

show("db-keys", Object.keys(db));
show("db-names", Object.getOwnPropertyNames(db));
show("stmt-keys", Object.keys(stmt));
show("tag-keys", Object.keys(store));
show("db-json", JSON.parse(JSON.stringify(db)));
show("stmt-json", JSON.parse(JSON.stringify(stmt)));
show("tag-json", JSON.parse(JSON.stringify(store)));

const descriptorShape = (target: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key) as PropertyDescriptor;
  return {
    keys: Object.keys(descriptor),
    enumerable: descriptor.enumerable,
    configurable: descriptor.configurable,
    get: typeof descriptor.get,
    set: typeof descriptor.set,
    value: descriptor.get ? descriptor.get.call(target) : descriptor.value,
  };
};
show("db-desc-isOpen", descriptorShape(db, "isOpen"));
show("db-desc-isTransaction", descriptorShape(db, "isTransaction"));
show("db-desc-limits", descriptorShape(db, "limits"));
show("stmt-desc-source", descriptorShape(stmt, "sourceSQL"));
show("stmt-desc-expanded", descriptorShape(stmt, "expandedSQL"));
show("tag-desc-capacity", descriptorShape(store, "capacity"));
show("tag-desc-size", descriptorShape(store, "size"));

const getter = Object.getOwnPropertyDescriptor(db, "isOpen")!.get!;
show("getter-stable", getter === Object.getOwnPropertyDescriptor(db, "isOpen")!.get);
const other = new DatabaseSync(":memory:");
show("getter-shared", getter === Object.getOwnPropertyDescriptor(other, "isOpen")!.get);
try {
  getter.call({});
  show("getter-wrong", "none");
} catch (error) {
  const e = error as { name: string; code?: string; message: string };
  show("getter-wrong", [e.name, e.code, e.message]);
}
other.close();

show("has-own", [Object.hasOwn(db, "isOpen"), Object.hasOwn(db, "close"), Object.hasOwn(stmt, "sourceSQL")]);
show("in", ["isOpen" in db, "close" in db, "nope" in db, "expandedSQL" in stmt]);

const dbRecord: Record<string, unknown> = db as unknown as Record<string, unknown>;
const stmtRecord: Record<string, unknown> = stmt as unknown as Record<string, unknown>;
const storeRecord: Record<string, unknown> = store as unknown as Record<string, unknown>;
dbRecord.added = 7;
stmtRecord.mark = "s";
storeRecord.tagged = true;
show("added-keys", Object.keys(db));
show("added-json", JSON.parse(JSON.stringify(db)));
show("added-read", [dbRecord.added, stmtRecord.mark, storeRecord.tagged]);
show("added-desc", Object.getOwnPropertyDescriptor(db, "added"));
let addedDeleted = false;
try {
  delete dbRecord.added;
  addedDeleted = true;
} catch {
  addedDeleted = false;
}
show("added-delete", addedDeleted);
show("after-delete", Object.keys(db));

show("inspect-db", inspect(db, { depth: 1 }));
show("inspect-stmt", inspect(stmt));
show("inspect-tag", inspect(store, { breakLength: 200 }));
show("inspect-tag-narrow", inspect(store, { breakLength: 40 }));
show("tag-db-identity", (store as unknown as { db: unknown }).db === db);
show("symbol-read", Reflect.get(db as unknown as object, Symbol.for("sqlite-type")));
show("symbol-other", Reflect.get(stmt as unknown as object, Symbol.for("sqlite-type")));
show("values", Object.values(db).slice(0, 2));

try {
  dbRecord.isOpen = false;
  show("write-accessor", "none");
} catch (error) {
  const e = error as { name: string; message: string };
  show("write-accessor", [e.name, e.message]);
}
try {
  delete dbRecord.limits;
  show("delete-accessor", "none");
} catch (error) {
  const e = error as { name: string; message: string };
  show("delete-accessor", [e.name, e.message]);
}

stmt.close();
show("closed-stmt-keys", Object.keys(stmt));
try {
  show("closed-stmt-json", JSON.parse(JSON.stringify(stmt)));
} catch (error) {
  const e = error as { code?: string; message: string };
  show("closed-stmt-json", [e.code, e.message]);
}
show("closed-stmt-desc", Object.keys(Object.getOwnPropertyDescriptor(stmt, "sourceSQL")!));

db.close();
show("closed-db-keys", Object.keys(db));
show("closed-db-isOpen", db.isOpen);
try {
  show("closed-db-json", JSON.parse(JSON.stringify(db)));
} catch (error) {
  const e = error as { code?: string; message: string };
  show("closed-db-json", [e.code, e.message]);
}
show("closed-descriptor", Object.getOwnPropertyDescriptor(db, "isOpen") ? "present" : "missing");
show("closed-inspect", inspect(db, { depth: 0 }));
console.log("limits-keys", JSON.stringify(Object.keys(limits).slice(0, 2)));

// The limits object keeps its own shape: the added properties first (its
// limits are interceptor-provided), then the limits in Node's order.
console.log("limits-added", JSON.stringify(Object.keys(limits).length));
