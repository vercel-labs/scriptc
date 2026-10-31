// Proxy.revocable: Node's { proxy, revoke } pair. The proxy answers through
// its handler until revoke runs; afterwards every trap-mediated operation
// throws, and revoke itself stays idempotent.
const target = { value: 1, other: 2 };
const handler = {
  get(t, key) { return key === "value" ? t.value * 10 : t[key]; },
  has(t, key) { return key === "other"; },
};
const revocable = Proxy.revocable(target, handler);
const proxy = revocable.proxy;
const revoke = revocable.revoke;
console.log(typeof proxy, proxy.value, "other" in proxy, "value" in proxy);
console.log(typeof revoke, revoke.name === "", revoke.length);
revoke();
revoke();
console.log(undefined, typeof proxy, proxy !== target, revocable.proxy === proxy);

try { console.log(proxy.value); } catch (error) { console.log(error.name, error.message); }
try { console.log("other" in proxy); } catch (error) { console.log(error.name, error.message); }
try { console.log(Object.keys(proxy).length); } catch (error) { console.log(error.name, error.message); }
try { console.log(Object.getOwnPropertyDescriptor(proxy, "value")); }
catch (error) { console.log(error.name, error.message); }
try { proxy.value = 5; console.log("set ok"); } catch (error) { console.log(error.name, error.message); }
try { delete proxy.value; console.log("delete ok"); } catch (error) { console.log(error.name, error.message); }
try { console.log(Reflect.getPrototypeOf(proxy)); } catch (error) { console.log(error.name, error.message); }
try { console.log(Reflect.setPrototypeOf(proxy, null)); } catch (error) { console.log(error.name, error.message); }
try { console.log(Reflect.isExtensible(proxy)); } catch (error) { console.log(error.name, error.message); }
try { console.log(Reflect.preventExtensions(proxy)); } catch (error) { console.log(error.name, error.message); }
try { console.log(Object.getPrototypeOf(proxy)); } catch (error) { console.log(error.name, error.message); }

// A second revocable over the same target keeps working after the first is
// revoked, and revoking it leaves the target itself alone.
const second = Proxy.revocable(target, handler);
second.revoke();
console.log(target.value, target.other, second.proxy === proxy);
const third = Proxy.revocable(target, {
  get(t, key) { return key === "value" ? "third:value" : "third:other"; },
});
console.log(third.proxy.value, third.proxy.other);
third.revoke();
try { console.log(third.proxy.value); } catch (error) { console.log(error.name); }

// A revoked callable proxy refuses the apply trap.
const callable = Proxy.revocable(function add(a, b) { return a + b; }, {});
console.log(typeof callable.proxy);
callable.proxy(1, 2);
callable.revoke();
try { callable.proxy(1, 2); } catch (error) { console.log(error.name, error.message); }

// Revoking from inside a trap leaves the running operation alone.
let revokeInside = null;
const nested = Proxy.revocable({}, { get() { revokeInside(); return "value"; } });
revokeInside = nested.revoke;
console.log(nested.proxy.missing);
try { console.log(nested.proxy.missing); } catch (error) { console.log(error.name); }
