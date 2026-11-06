// The registry classes are imported by main.ts for their TYPES only, so the
// program never compiles them as classes: their instance types are
// structural shapes, and getAuth is the class's overload set.
export interface Model {
  provider: string;
  id: string;
}

export interface AuthOverrides {
  env?: string;
}

export class Runtime {
  getAuth(providerId: string, overrides?: AuthOverrides): Promise<string | undefined>;
  getAuth(model: Model, overrides?: AuthOverrides): Promise<string | undefined>;
  async getAuth(target: string | Model, overrides: AuthOverrides = {}): Promise<string | undefined> {
    return typeof target === "string" ? `class:${target}:${overrides.env ?? "-"}` : `class:${target.id}`;
  }
}

export class Registry {
  readonly runtime: Runtime;
  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }
}
