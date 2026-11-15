declare module "dialmeter" {
  export class Meter {
    constructor(options?: Record<string, unknown>);
    read(): string;
    face(name: string): Promise<string>;
  }
}
