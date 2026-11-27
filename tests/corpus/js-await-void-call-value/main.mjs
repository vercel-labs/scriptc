const Internals = {
  /** @returns {void} */
  f() {
    return "value";
  },
  /** @returns {void} */
  g() {
    return undefined;
  },
};

async function main() {
  const a = (await Internals.f()) || "fallback";
  console.log(a);
  const b = (await Internals.f()) && "hit";
  console.log(b);
  const c = (await Internals.g()) || "fallback";
  console.log(c);
}

main();
