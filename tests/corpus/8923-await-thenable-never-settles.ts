// A thenable that never calls its resolver: the await calls `then` and never
// continues, so the function's later statements do not run and the process
// ends with nothing left to do, exit code 0, as under Node.
process.on("exit", (code) => console.log("exit", code));

const never = {
  then(_resolve: (v: number) => void): void {
    console.log("then called, never resolves");
  },
};

async function typed(): Promise<void> {
  console.log("typed: before");
  await never;
  console.log("typed: unreachable");
}

async function dynamic(value: unknown): Promise<void> {
  console.log("dynamic: before");
  await value;
  console.log("dynamic: unreachable");
}

typed().then(() => console.log("typed: unreachable settlement"));
dynamic(never).then(() => console.log("dynamic: unreachable settlement"));
console.log("sync end");
