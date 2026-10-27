import dgram = require("dgram");

declare module "hot-shots" {
  export type Tags = { [key: string]: string } | string[];
  export interface ClientOptions {
    bufferFlushInterval?: number;
    bufferHolder?: { buffer: string };
    cacheDns?: boolean;
    cacheDnsTtl?: number;
    errorHandler?: (err: Error) => void;
    globalTags?: Tags;
    globalize?: boolean;
    host?: string;
    isChild?: boolean;
    maxBufferSize?: number;
    mock?: boolean;
    path?: string;
    port?: number;
    prefix?: string;
    protocol?: 'tcp' | 'udp' | 'uds';
    sampleRate?: number;
    socket?: dgram.Socket;
    suffix?: string;
    telegraf?: boolean;
    useDefaultRoute?: boolean;
    tagPrefix?: string;
    tagSeparator?: string;
    udsGracefulErrorHandling?: boolean;
    udsGracefulRestartRateLimit?: number;
    closingFlushInterval?: number;
  }

  export interface ChildClientOptions {
    globalTags?: Tags;
    prefix?: string;
    suffix?: string;
  }

  export interface CheckOptions {
    date_happened?: Date;
    hostname?: string;
    message?: string;
  }

  export interface DatadogChecks {
    OK: 0;
    WARNING: 1;
    CRITICAL: 2;
    UNKNOWN: 3;
  }

  type unionFromInterfaceValues4<
    T,
    K1 extends keyof T,
    K2 extends keyof T,
    K3 extends keyof T,
    K4 extends keyof T,
    > = T[K1] | T[K2] | T[K3] | T[K4];

  export type DatadogChecksValues = unionFromInterfaceValues4<DatadogChecks, "OK", "WARNING", "CRITICAL", "UNKNOWN">;

  export interface EventOptions {
    aggregation_key?: string;
    alert_type?: "info" | "warning" | "success" | "error";
    date_happened?: Date;
    hostname?: string;
    priority?: "low" | "normal";
    source_type_name?: string;
  }

  export type StatsCb = (error: Error | undefined, bytes: any) => void;

  export class StatsD {
    constructor(options?: ClientOptions);
    childClient(options?: ChildClientOptions): StatsD;

    increment(stat: string, tags?: Tags): void;
    increment(stat: string | string[], value: number, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    increment(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
    increment(stat: string | string[], value: number, callback?: StatsCb): void;
    increment(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;

    decrement(stat: string): void;
    decrement(stat: string | string[], value: number, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    decrement(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
    decrement(stat: string | string[], value: number, callback?: StatsCb): void;
    decrement(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;

    timing(stat: string | string[], value: number | Date, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    timing(stat: string | string[], value: number | Date, tags?: Tags, callback?: StatsCb): void;
    timing(stat: string | string[], value: number | Date, callback?: StatsCb): void;
    timing(stat: string | string[], value: number | Date, sampleRate?: number, callback?: StatsCb): void;

    timer<P extends any[], R>(func: (...args: P) => R, stat: string | string[], sampleRate?: number, tags?: Tags, callback?: StatsCb): (...args: P) => R;
    timer<P extends any[], R>(func: (...args: P) => R, stat: string | string[], tags?: Tags, callback?: StatsCb): (...args: P) => R;
    timer<P extends any[], R>(func: (...args: P) => R, stat: string | string[], callback?: StatsCb): (...args: P) => R;
    timer<P extends any[], R>(func: (...args: P) => R, stat: string | string[], sampleRate?: number, callback?: StatsCb): (...args: P) => R;

    asyncTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], sampleRate?: number, tags?: Tags, callback?: StatsCb): (...args: P) => Promise<R>;
    asyncTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], tags?: Tags, callback?: StatsCb): (...args: P) => Promise<R>;
    asyncTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], callback?: StatsCb): (...args: P) => Promise<R>;
    asyncTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], sampleRate?: number, callback?: StatsCb): (...args: P) => Promise<R>;

    asyncDistTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], sampleRate?: number, tags?: Tags, callback?: StatsCb): (...args: P) => Promise<R>;
    asyncDistTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], tags?: Tags, callback?: StatsCb): (...args: P) => Promise<R>;
    asyncDistTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], callback?: StatsCb): (...args: P) => Promise<R>;
    asyncDistTimer<P extends any[], R>(func: (...args: P) => Promise<R>, stat: string | string[], sampleRate?: number, callback?: StatsCb): (...args: P) => Promise<R>;

    histogram(stat: string | string[], value: number, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    histogram(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
    histogram(stat: string | string[], value: number, callback?: StatsCb): void;
    histogram(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;

    distribution(stat: string | string[], value: number, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    distribution(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
    distribution(stat: string | string[], value: number, callback?: StatsCb): void;
    distribution(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;

    gauge(stat: string | string[], value: number, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    gauge(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
    gauge(stat: string | string[], value: number, callback?: StatsCb): void;
    gauge(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;

    set(stat: string | string[], value: number | string, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    set(stat: string | string[], value: number | string, tags?: Tags, callback?: StatsCb): void;
    set(stat: string | string[], value: number | string, callback?: StatsCb): void;
    set(stat: string | string[], value: number | string, sampleRate?: number, callback?: StatsCb): void;

    unique(stat: string | string[], value: number | string, sampleRate?: number, tags?: Tags, callback?: StatsCb): void;
    unique(stat: string | string[], value: number | string, tags?: Tags, callback?: StatsCb): void;
    unique(stat: string | string[], value: number | string, callback?: StatsCb): void;
    unique(stat: string | string[], value: number | string, sampleRate?: number, callback?: StatsCb): void;

    close(callback?: (error?: Error) => void): void;

    event(title: string, text?: string, options?: EventOptions, tags?: Tags, callback?: StatsCb): void;
    event(title: string, text?: string, options?: EventOptions, callback?: StatsCb): void;
    check(name: string, status: DatadogChecksValues, options?: CheckOptions, tags?: Tags, callback?: StatsCb): void;

    public CHECKS: DatadogChecks;
    public mockBuffer?: string[];
    public socket: dgram.Socket;
  }
}

declare const StatsDClient: new (options?: ClientOptions) => StatsD;
export default StatsDClient;
