// A foreground lease belongs to one sync run and is always released on exit.
export class TransferSession {
  constructor({ start, stop, update, visible }) {
    Object.assign(this, { start, stop, update, visible });
    this.active = false;
    this.starting = null;
  }
  async begin() {
    if (this.active) return true;
    if (!this.visible()) return false;
    if (!this.starting)
      this.starting = this.start()
        .then(() => {
          this.active = true;
          return true;
        })
        .finally(() => {
          this.starting = null;
        });
    return this.starting;
  }
  async end() {
    if (this.starting) await this.starting.catch(() => {});
    if (!this.active) return;
    this.active = false;
    await this.stop();
  }
  progress(progress) {
    if (this.active) void this.update(progress).catch(() => {});
  }
}
export const shouldStopSync = (state, leased) =>
  state === "background" && !leased;
