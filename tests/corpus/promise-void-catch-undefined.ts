// `Promise<void>.catch(() => undefined)` — the handler's value is
// discarded and the recovered promise settles as void. The handler runs
// exactly once, and the chain continues on the next turn whether the
// receiver fulfilled or rejected.

const ok: Promise<void> = Promise.resolve();
const bad: Promise<void> = Promise.reject(new Error("boom"));

ok.catch(() => undefined).then(() => console.log("fulfilled recovered"));

bad
  .catch(() => {
    console.log("rejected recovered");
  })
  .then(() => console.log("rejected continued"));

let runs = 0;

function recover(): Promise<void> {
  runs++;
  return runs % 2 === 1 ? Promise.reject(new Error("odd")) : Promise.resolve();
}

async function run(): Promise<void> {
  await recover().catch(() => undefined);
  console.log("awaited recover", runs);
  await recover().catch(() => undefined);
  console.log("awaited recover", runs);
}

void run().then(() => console.log("done"));
