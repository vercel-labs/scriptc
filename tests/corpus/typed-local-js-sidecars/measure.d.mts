export interface Meter { read(): number }
export type Factory = new (amount: number) => Meter;
export interface Result { amount: number }
export declare function measure(Type: Factory): Result;
export default measure;
