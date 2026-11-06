// Rest bindings over index-signature sources keep the fences the capture
// reshape cannot serve: a runtime computed sibling key (the consumed set is
// a runtime fact), a declared integer-like field name (JS hoists integer
// keys across the declared and overflow stores), a CLOSED rest type over a
// hybrid source (its undeclared keys have no slot in the target), and an
// accessor source (its getters are closures, not data the copy may move).
interface K {
  a?: string;
  b?: number;
}

type H = K & Record<string, unknown>;

function computedSibling(h: H, key: string): void {
  const { [key]: taken, ...rest } = h;
  console.log(taken, rest);
}

interface IntegerField {
  "10": string;
  [key: string]: string;
}

function declaredIntegerField(source: IntegerField): void {
  const { ...rest } = source;
  console.log(rest);
}

function closedRest<T extends K>(item: T): void {
  const { a, ...rest } = item;
  console.log(a, rest);
}

function accessorSource(): void {
  const source = {
    get a() {
      return 1;
    },
    b: 2,
  };
  const { b, ...rest } = source;
  console.log(b, rest);
}

computedSibling({ a: "s", q: 1 } as H, "q");
declaredIntegerField({ "10": "x", y: "z" });
closedRest({ a: "s", b: 1 } as H);
accessorSource();
