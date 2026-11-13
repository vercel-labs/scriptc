// A native Proxy assigned to a string-keyed dictionary stays the Proxy:
// reads, writes, `in`, `delete` and a dictionary-typed parameter all reach
// its traps, and the value keeps the identity the traps act on.
function keyed(): Record<string, string> {
  const store: Record<string, string> = {};
  return new Proxy(store as any, {
    get(t: any, k: any): any {
      if (k === "keys") return Object.keys(t).sort().join(",");
      return k in t ? t[k] : "missing";
    },
    set(t: any, k: any, v: any): any {
      t[k] = v.toUpperCase();
      return true;
    },
    has(t: any, k: any): any {
      return k === "virtual" || k in t;
    },
    deleteProperty(t: any, k: any): any {
      delete t[k];
      return true;
    },
  });
}

const map = keyed();
map.a = "one";
map.b = "two";
console.log("read " + map.a + " " + map.absent);
console.log("keys " + map.keys);
console.log("in " + ("virtual" in map) + " " + ("a" in map) + " " + ("nope" in map));
delete map.a;
console.log("after delete " + map.keys);

// The same Proxy through a dictionary-typed parameter.
function fill(table: Record<string, string>): void {
  table.c = "three";
}
fill(map);
console.log("param " + map.keys);

// A Proxy built over a dictionary-typed target converts like the object it
// stands in for.
const direct: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(t: any, k: any): any {
    return k === "x" ? "1" : "none";
  },
});
console.log("direct " + direct.x + " " + direct.other);
