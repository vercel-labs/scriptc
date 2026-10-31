// An untyped value frozen and then held as a typed record stays frozen:
// writes to it in strict mode code throw Node's TypeError and leave it
// unchanged. An unfrozen value checked into the same record type stays
// writable.

type Counter = { count: number; label: string };

function bump(c: Counter, by: number): string {
  try {
    c.count += by;
    return "wrote " + c.count;
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : "other";
  }
}

const frozen = Object.freeze(JSON.parse('{"count":1,"label":"a"}')) as Counter;
console.log(bump(frozen, 2), frozen.count, Object.isFrozen(frozen));

const open = JSON.parse('{"count":10,"label":"b"}') as Counter;
console.log(bump(open, 2), open.count, Object.isFrozen(open));

const raw: unknown = Object.freeze(JSON.parse('{"count":20,"label":"c"}'));
const viaUnknown = raw as Counter;
console.log(bump(viaUnknown, 2), viaUnknown.count, Object.isFrozen(viaUnknown));

// A proxy checked into the record type stays writable.
const proxied = new Proxy({ count: 40, label: "q" }, {}) as Counter;
console.log(bump(proxied, 2), proxied.count);
