import type { Store } from './domain.js';

export class AccountRiskAlertWorker {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<number>;

  constructor(private readonly store: Store, private readonly onError: (error: unknown) => void) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce().catch(this.onError);
    this.timer = setInterval(() => { void this.pollOnce().catch(this.onError); }, 1_000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async pollOnce(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.store.flushAccountRiskAlerts(50).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}
