/* An object literal computed key must not enter the class-method mutation
 * census: the literal is a fresh value under construction, so its key names
 * no method of any class. The uncalled poison function used to demote every
 * collected method name program-wide, and generic instances then resolved
 * their methods to undefined. */
class Ctx<T = string> {
  v: number;
  constructor() { this.v = 0; }
  json(o: T): string { return JSON.stringify(o); }
  status(n: number): Ctx<T> { this.v = n; return this; }
}
function poison(kp: string) {
  const r: Record<string, number> = { [kp]: 1 };
  return r;
}
const c = new Ctx<{ ok: boolean }>();
console.log(typeof c.json, typeof c.status, c.status(200).json({ ok: true }), poison("k")["k"]);
