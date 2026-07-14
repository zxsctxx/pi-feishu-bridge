export class ConfigReloadCoordinator {
  private pending = false;
  get hasPending(): boolean { return this.pending; }
  async request(idle: boolean, apply: () => Promise<void>): Promise<"applied" | "deferred"> {
    if (!idle) { this.pending = true; return "deferred"; }
    await apply(); return "applied";
  }
  async afterSettled(apply: () => Promise<void>): Promise<boolean> {
    if (!this.pending) return false; this.pending = false; await apply(); return true;
  }
}
