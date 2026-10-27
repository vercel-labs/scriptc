export class Emitted {
  readonly count: number;
  readonly files: string[];
  constructor(count: number, files: string[]) {
    this.count = count;
    this.files = files;
  }
  summary(): string {
    return `${this.count} files`;
  }
}

export class Sealed {
  #secret = 1;
  read(): number {
    return this.#secret;
  }
}

export class Totals {
  emitted = 0;
  skipped = 0;
}
