// An object literal made of getters is returned at its interface, then
// widened in place with Object.defineProperties: asserted to the wider
// interface, with one more getter and an async method. The descriptor map is
// a typed object literal, which the call reads as any other object.
interface Base {
  readonly label: string;
  readonly depth: number;
}

interface Wide extends Base {
  readonly items: string[];
  run(name: string): Promise<string>;
}

class Runner {
  private active = true;
  private level = 2;

  assertActive(): void {
    if (!this.active) throw new Error("the runner is not active");
  }

  stop(): void {
    this.active = false;
  }

  createContext(): Base {
    const runner = this;
    return {
      get label() {
        runner.assertActive();
        return "context";
      },
      get depth() {
        return runner.level;
      },
    };
  }

  createWide(id: string): Wide {
    const runner = this;
    // createContext() answers a fresh object, so the properties added here
    // are on this context only.
    return Object.defineProperties(this.createContext() as Wide, {
      items: {
        get() {
          runner.assertActive();
          return ["a", "b"];
        },
      },
      run: {
        value: async (name: string) => `${id}/${name}`,
      },
    });
  }
}

async function main(): Promise<void> {
  const runner = new Runner();
  const wide = runner.createWide("call_1");
  console.log(wide.label, wide.depth, wide.items.join(","), await wide.run("x"));
  console.log(Object.keys(wide).join(","), "items" in wide, typeof wide.run);
  const other = runner.createContext();
  console.log(Object.keys(other).join(","), "items" in other);
  runner.stop();
  try {
    console.log(wide.items.length);
  } catch (error) {
    console.log("stopped:", error instanceof Error ? error.message : String(error));
  }
  console.log(await wide.run("y"), wide.depth);
}

main();
