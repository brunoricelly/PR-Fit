export class SerialWriteQueue {
  #running = false;
  #items = [];

  get pending() { return this.#items.length + (this.#running ? 1 : 0); }

  run(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
    if (!this.#running) return this.#start(task);
    return new Promise((resolve, reject) => this.#items.push({ task, resolve, reject }));
  }

  #start(task, queued = null) {
    this.#running = true;
    let result;
    try { result = task(); }
    catch (error) {
      this.#finish();
      if (queued) queued.reject(error);
      return queued ? undefined : Promise.reject(error);
    }
    const promise = Promise.resolve(result);
    if (queued) promise.then(
      value => { queued.resolve(value); this.#finish(); },
      error => { queued.reject(error); this.#finish(); },
    );
    else promise.then(() => this.#finish(), () => this.#finish());
    return queued ? undefined : promise;
  }

  #finish() {
    this.#running = false;
    const next = this.#items.shift();
    if (next) this.#start(next.task, next);
  }
}
