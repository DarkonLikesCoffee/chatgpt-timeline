// Delivers tracker output to the service worker. Messages are sent in order;
// a failed send (service worker starting up) is retried with backoff. If the
// extension was reloaded or removed, the context is invalidated and the
// content script stops.

export class Transport {
  constructor({ send, onDead = () => {}, retryDelays = [200, 500, 1000, 2000, 5000, 10000] } = {}) {
    this.sendImpl = send;
    this.onDead = onDead;
    this.retryDelays = retryDelays;
    this.queue = [];
    this.sending = false;
    this.dead = false;
  }

  send(message) {
    if (this.dead) return;
    this.queue.push({ message, attempt: 0 });
    this.pump();
  }

  get pending() {
    return this.queue.length;
  }

  async pump() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.dead) {
        const item = this.queue[0];
        try {
          await this.sendImpl(item.message);
          this.queue.shift();
        } catch (err) {
          if (/context invalidated/i.test(String(err?.message || err))) {
            this.dead = true;
            this.queue = [];
            this.onDead(err);
            break;
          }
          const delay = this.retryDelays[item.attempt++];
          if (delay == null) {
            console.warn('[ChatGPT Timeline] dropping message after retries', err);
            this.queue.shift();
          } else {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
