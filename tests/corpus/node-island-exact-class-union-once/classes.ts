export class Token {
  value = 7;
}

export class Queue {
  next: Token | null = new Token();
  take(): Token | null {
    const token = this.next;
    this.next = null;
    return token;
  }
}

export class Drain extends Queue {}
