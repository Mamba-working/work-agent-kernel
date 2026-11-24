// A synchronous result is already settled. Async I/O returns the commit for the driver to execute.
export type Prepared<T> = T | Promise<() => T>;
export async function settle<T>(work: Prepared<T>): Promise<T> {
  return work instanceof Promise ? (await work)() : work;
}

export class Stage {
  private pending?: Promise<void> | undefined;
  private commit?: (() => boolean) | undefined;

  async advance(take: () => Prepared<boolean>, manual: boolean, wake: () => void) {
    if (!this.pending) {
      const work = take();
      if (!(work instanceof Promise)) return work;
      this.pending = work
        .then(
          (ok) => {
            this.commit = ok;
          },
          (error) => {
            this.commit = () => {
              throw error;
            };
          },
        )
        .then(wake);
    }
    if (manual) await this.pending;
    return this.finish();
  }
  private finish() {
    const commit = this.commit;
    if (!commit) return false;
    this.pending = undefined;
    this.commit = undefined;
    return commit();
  }
  get busy() {
    return !!this.pending;
  }
  async drain() {
    await this.pending;
    this.finish();
  }
}
