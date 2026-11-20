// The pool merge's planning (mergePlan.js) on its own thread, so a merge never holds up the requests the main
// thread serves. MergeWorker is the main thread's side; run as a worker, this file answers its messages.
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { MergePlanner } = require('./mergePlan');

if (!isMainThread && parentPort) {
    const planner = new MergePlanner();
    parentPort.on('message', ({ id, type, payload }) => {
        try {
            if (type === 'provider') parentPort.postMessage({ id, result: planner.setProvider(payload) });
            else if (type === 'plan') {
                const result = planner.plan(payload.order);
                parentPort.postMessage({ id, result }, [result.layout.buffer]);
            } else throw new Error(`Unknown message ${type}`);
        } catch (e) {
            parentPort.postMessage({ id, error: e.message });
        }
    });
}

/** Sends planning work to the worker. Once the worker fails, every call fails, and the pool plans in-process. */
class MergeWorker {
    constructor() {
        this.worker = new Worker(path.join(__dirname, 'mergeWorker.js'));
        this.pending = new Map();
        this.next = 0;
        this.dead = null;
        this.worker.unref();
        this.worker.on('message', ({ id, result, error }) => {
            const call = this.pending.get(id);
            if (!call) return;
            this.pending.delete(id);
            if (!this.pending.size) this.worker.unref();
            if (error) call.reject(new Error(error));
            else call.resolve(result);
        });
        const fail = (e) => {
            if (this.dead) return;
            this.dead = e;
            for (const call of this.pending.values()) call.reject(e);
            this.pending.clear();
        };
        this.worker.on('error', fail);
        this.worker.on('exit', (code) => fail(new Error(`merge worker exited (${code})`)));
    }

    call(type, payload) {
        if (this.dead) return Promise.reject(this.dead);
        return new Promise((resolve, reject) => {
            const id = ++this.next;
            this.pending.set(id, { resolve, reject });
            // A waiting call keeps the process alive, so a test (or a startup) awaiting it doesn't exit first.
            this.worker.ref();
            this.worker.postMessage({ id, type, payload });
        });
    }

    setProvider(payload) {
        return this.call('provider', payload);
    }

    plan(order) {
        return this.call('plan', { order });
    }

    stop() {
        this.worker.terminate();
    }
}

/** The same planning on the main thread, for when the worker is off or has failed. */
class InlinePlanner {
    constructor() {
        this.planner = new MergePlanner();
    }

    async setProvider(payload) {
        return this.planner.setProvider(payload);
    }

    async plan(order) {
        return this.planner.plan(order);
    }

    stop() { }
}

module.exports = { MergeWorker, InlinePlanner };
