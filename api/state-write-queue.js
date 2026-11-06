export class StateWriteQueue {
  #tails = new Map();

  get size() { return this.#tails.size; }

  async run(uid, task) {
    const previous = this.#tails.get(uid);
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.#tails.set(uid, current);
    if (previous) await previous;
    try { return await task(); }
    finally {
      release();
      if (this.#tails.get(uid) === current) this.#tails.delete(uid);
    }
  }
}
