// A heterogeneous Promise.all tuple observes every entry immediately: the
// fast rejection wins even when the first tuple entry is still pending, and
// the slower fulfillment still runs without becoming an unhandled rejection.
function slow(): Promise<string> {
  return new Promise((resolve) =>
    setTimeout(() => {
      console.log("settled: slow");
      resolve("slow");
    }, 25),
  );
}

function fastReject(): Promise<number> {
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      console.log("rejected: fast");
      reject(new Error("fast"));
    }, 1),
  );
}

async function main(): Promise<void> {
  try {
    await Promise.all([slow(), fastReject()] as const);
    console.log("unreachable");
  } catch (e) {
    console.log("caught:", e instanceof Error ? e.message : "?");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  console.log("end");
}

void main();
