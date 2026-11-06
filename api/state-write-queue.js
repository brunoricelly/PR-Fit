import { AsyncLocalStorage } from 'node:async_hooks';

export class StateWriteQueueFullError extends Error {
  constructor(scope) {
    super(scope === 'key' ? 'state write limit reached for this profile' : 'global state write limit reached');
    this.name = 'StateWriteQueueFullError';
    this.scope = scope;
  }
}

export class StateWriteQueueReentrancyError extends Error {
  constructor(key) {
    super(`state write queue is not reentrant for ${key}`);
    this.name = 'StateWriteQueueReentrancyError';
  }
}

export class StateWriteQueue {
  #queues = new Map();
  #context = new AsyncLocalStorage();
  #pending = 0;
  #perKeyLimit;
  #globalLimit;

  constructor({ perKeyLimit = 4, globalLimit = 128 } = {}) {
    if (!Number.isInteger(perKeyLimit) || perKeyLimit < 1) throw new RangeError('perKeyLimit must be a positive integer');
    if (!Number.isInteger(globalLimit) || globalLimit < 1) throw new RangeError('globalLimit must be a positive integer');
    this.#perKeyLimit = perKeyLimit;
    this.#globalLimit = globalLimit;
  }

  get size() { return this.#queues.size; }
  get pending() { return this.#pending; }

  run(key, task, { signal } = {}) {
    if (this.#context.getStore() === key) return Promise.reject(new StateWriteQueueReentrancyError(key));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('state write cancelled'));

    let queue = this.#queues.get(key);
    const keyPending = queue ? queue.items.length : 0;
    if (keyPending >= this.#perKeyLimit) return Promise.reject(new StateWriteQueueFullError('key'));
    if (this.#pending >= this.#globalLimit) return Promise.reject(new StateWriteQueueFullError('global'));

    if (!queue) {
      queue = { running: false, items: [] };
      this.#queues.set(key, queue);
    }
    this.#pending++;

    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal, abort: null };
      if (signal) {
        item.abort = () => {
          if (queue.running && queue.items[0] === item) return;
          const index = queue.items.indexOf(item);
          if (index === -1) return;
          queue.items.splice(index, 1);
          this.#pending--;
          signal.removeEventListener('abort', item.abort);
          reject(signal.reason || new Error('state write cancelled'));
          if (!queue.running && queue.items.length === 0) this.#queues.delete(key);
        };
        signal.addEventListener('abort', item.abort, { once: true });
      }
      queue.items.push(item);
      this.#start(key, queue);
    });
  }

  #start(key, queue) {
    if (queue.running || queue.items.length === 0) return;
    queue.running = true;
    const item = queue.items[0];
    if (item.abort) item.signal.removeEventListener('abort', item.abort);

    const finish = () => {
      queue.items.shift();
      queue.running = false;
      this.#pending--;
      if (queue.items.length === 0) this.#queues.delete(key);
      else this.#start(key, queue);
    };
    Promise.resolve()
      .then(() => this.#context.run(key, item.task))
      .then(
        value => { finish(); item.resolve(value); },
        error => { finish(); item.reject(error); },
      );
  }
}
