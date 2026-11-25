export type Entry = {
  memo?: string;
  name: string;
  amount: number;
  tags: Record<string, string>;
};
export type Sink = { record: (entry: Entry) => void };
export declare class Ledger {
  constructor(options: { name: string; sink: Sink });
  post(name: string, amount: number): void;
}
