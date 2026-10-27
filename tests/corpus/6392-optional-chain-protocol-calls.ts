// Optional calls on an interface-typed method chain (a do-nothing tracer).
interface Span {
  addTags(tags: Record<string, unknown>): Span;
}
interface Scope {
  active(): Span | null;
}
interface Tracer {
  scope(): Scope;
}
class NoopSpan implements Span {
  addTags(tags: Record<string, unknown>): Span {
    console.log("tags", JSON.stringify(tags));
    return this;
  }
}
class NoopScope implements Scope {
  span: Span | null;
  constructor(span: Span | null) {
    this.span = span;
  }
  active(): Span | null {
    return this.span;
  }
}
class NoopTracer implements Tracer {
  s: Scope;
  constructor(s: Scope) {
    this.s = s;
  }
  scope(): Scope {
    return this.s;
  }
}
const quiet: Tracer = new NoopTracer(new NoopScope(null));
const loud: Tracer = new NoopTracer(new NoopScope(new NoopSpan()));
function tagActiveSpan(tracer: Tracer, tags: Record<string, unknown>): void {
  tracer.scope().active()?.addTags(tags);
}
tagActiveSpan(quiet, { a: 1 });
tagActiveSpan(loud, { b: 2 });

// Narrowed locals and non-null assertions reach the same protocol calls.
const scope2: Scope = new NoopScope(new NoopSpan());
const current = scope2.active();
current?.addTags({ c: 3 });
scope2.active()!.addTags({ d: 4 });
