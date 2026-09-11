/** A terminal transport: connect, send a request and read one framed response. */
export interface Transport {
  connect(): Promise<void>;
  disconnect(): void;
  readonly isConnected: boolean;
  /** Send `message`, then read one complete response (up to `timeoutMs`). */
  sendReceive(message: string, timeoutMs: number): Promise<string>;
}

/** Thrown when a terminal does not respond within the timeout. */
export class TerminalTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`No response from terminal within ${timeoutMs}ms`);
    this.name = "TerminalTimeoutError";
  }
}
