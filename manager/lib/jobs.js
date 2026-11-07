import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { jobContext } from './jobcontext.js';
import { killJob } from './dockerctl.js';

/**
 * Runs the long operations the UI kicks off -- image builds, certificate
 * issuance, stack restarts -- one at a time, in the order they were asked for.
 *
 * One at a time is not a limitation to remove: these all end in `docker compose
 * up`, and two of them racing produces a container state nobody asked for. But
 * refusing the second was the wrong way to enforce it. Switching on three apps
 * meant waiting out a Rust build before being allowed to ask for the next one,
 * with a "Busy" error for trying -- and the only thing wrong with asking was
 * the timing, which a queue knows how to fix.
 */
/**
 * What the request that started a job asked for.
 *
 * Update and Rebuild send their work to the Update Queue instead of a
 * full-screen log: the page stays usable, several can be lined up, and the
 * queue page shows the one running and what waits behind it. The server wraps
 * every route in this store, so `start` knows which kind it is without every
 * route having to pass it along.
 */
export const requestContext = new AsyncLocalStorage();

class JobRunner extends EventEmitter {
    current = null;
    queue = [];
    history = [];
    #seq = 0;

    get busy() {
        return this.current !== null && this.current.status === 'running';
    }

    /** Whether the running job, or one waiting, said it works on `app`. */
    touches(app) {
        return (this.busy && this.current.app === app) || this.queue.some(({ job }) => job.app === app);
    }

    /** Everything asked for and not yet finished, in the order it will run. */
    get pending() {
        return this.queue.map(({ job }) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            queued: job.queued,
            queuedAt: job.queuedAt,
        }));
    }

    /**
     * Queues `fn`. `options.key` opts in to merging; `options.app` says which
     * app the job works on, so timers that touch that app can stay out of its
     * way.
     */
    start(name, fn, { key = null, app = null, noCancel: mustFinish = false } = {}) {
        const asked = requestContext.getStore();
        const queued = asked?.queued === true;
        // Some jobs have to run to the end once they start -- uninstalling is
        // the one that matters, and restoring an app from a backup. They can
        // still be dropped while they wait.
        const noCancel = asked?.noCancel === true || mustFinish === true;
        if (queued && asked.title) name = asked.title;

        /*
         * The same thing asked for again while it is the last one waiting can
         * be one job, with the latest click winning -- but only when the caller
         * says so, with a key that names the whole of what was asked for.
         *
         * This used to merge on the job's name, and a name is a label, not an
         * intent. Two worlds uploaded back to back were both "Add a Minecraft
         * world", so the second replaced the first: one world was never
         * imported and its upload sat in the temp folder. Two names published
         * for Nextcloud were both "Publishing Nextcloud", and only the second
         * was ever made. Only a caller knows when a repeat is truly the same
         * request -- a settings apply that reads the saved settings when it
         * runs, a start asked for twice -- so only a caller can say.
         *
         * Only when it is last, though -- anything queued behind it means the
         * order matters, and "stop, start, stop" has to end stopped. Once it is
         * running, asking again lines up a genuine second run, which is how to
         * pick up a commit pushed while the first one was building.
         */
        const last = this.queue[this.queue.length - 1];
        if (key !== null && last && last.key === key) {
            last.fn = fn;
            last.job.name = name;
            last.job.noCancel = noCancel;
            return last.job;
        }

        const job = {
            // Two clicks in the same millisecond used to collide, which nothing
            // noticed while only one job could exist at a time.
            id: `${Date.now().toString(36)}-${(this.#seq += 1).toString(36)}`,
            name,
            status: 'queued',
            // Watched on the Update Queue page rather than in the overlay.
            queued,
            noCancel,
            queuedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            app,
            lines: [],
            error: null,
        };

        this.queue.push({ job, fn, key });
        this.emit('queued', { ...job, ahead: this.queue.length - 1, running: this.current?.name ?? null });
        this.#drain();
        return job;
    }

    /**
     * Starts the next job if nothing is running. Called when one is added and
     * again when one finishes, so the queue empties itself.
     */
    #drain() {
        if (this.busy) return;
        const next = this.queue.shift();
        if (!next) return;

        const { job, fn } = next;
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        this.current = job;

        const log = (line) => {
            const text = String(line).replace(/\r/g, '').trimEnd();
            if (!text) return;
            job.lines.push(text);
            if (job.lines.length > 2000) job.lines.shift();
            this.emit('line', { jobId: job.id, line: text });
        };

        log(`> ${job.name}`);
        this.emit('start', job);

        Promise.resolve()
            .then(() => jobContext.run({ id: job.id }, () => fn(log)))
            .then(
                (result) => {
                    // A cancelled job can still finish cleanly: killing docker
                    // compose halfway through `up` leaves it having done part
                    // of the work and exiting 0. What was asked for is what
                    // this reports.
                    job.status = job.cancelled ? 'cancelled' : 'succeeded';
                    job.result = result ?? null;
                },
                (err) => {
                    // The error from a killed process describes the killing,
                    // not a fault. Somebody pressed cancel; say that.
                    job.status = job.cancelled ? 'cancelled' : 'failed';
                    // Bounded, because this is kept in the history and sent
                    // on every status poll; the full story is in the lines.
                    const message = String(err?.message || err);
                    job.error = job.cancelled ? 'Cancelled.' : message.length > 4000 ? `${message.slice(0, 4000)}...` : message;
                    log(job.cancelled ? '! Cancelled.' : `! ${job.error}`);
                },
            )
            .finally(() => {
                job.finishedAt = new Date().toISOString();
                this.emit('end', job);
                this.history.unshift({ ...job, lines: job.lines.slice(-200) });
                this.history = this.history.slice(0, 10);
                // Whatever is next starts now, not when somebody asks again.
                this.#drain();
            });
    }

    /**
     * Stops a job, whether it has started or not.
     *
     * A queued one simply never runs. A running one has its processes killed,
     * and what it had already done stays done: a half-finished build keeps its
     * layers, a half-finished uninstall does not put back what it removed. The
     * panel says so before asking.
     */
    cancel(id) {
        const queued = this.queue.findIndex(({ job }) => job.id === id);
        if (queued !== -1) {
            const [{ job }] = this.queue.splice(queued, 1);
            job.status = 'cancelled';
            job.error = 'Cancelled before it started.';
            job.finishedAt = new Date().toISOString();
            // Into the history as well. The queue page's Finished list is the
            // only place a dropped job is accounted for; without this it simply
            // vanishes off Waiting, which reads as the panel losing it.
            this.history.unshift({ ...job, lines: [job.error] });
            this.history = this.history.slice(0, 10);
            this.emit('end', { ...job, pending: this.pending });
            return { cancelled: true, started: false };
        }

        if (this.current?.id !== id || this.current.status !== 'running') {
            return { cancelled: false, reason: 'That job is not running.' };
        }

        if (this.current.noCancel) {
            return { cancelled: false, reason: 'This one cannot be stopped partway: it would leave half of it behind.' };
        }

        // Marked first: whichever way the function ends after its processes
        // die, the end handler has to know this was asked for.
        this.current.cancelled = true;
        this.emit('line', { jobId: id, line: 'Cancelling. Docker is being asked to stop.' });
        this.current.lines.push('Cancelling. Docker is being asked to stop.');
        const killed = killJob(id);
        if (!killed) {
            this.emit('line', {
                jobId: id,
                line: 'Nothing was running to stop, so this ends as soon as the step in progress returns.',
            });
        }
        return { cancelled: true, started: true, killed };
    }

    snapshot() {
        if (!this.current) return null;
        const { id, name, status, queued, noCancel, queuedAt, startedAt, finishedAt, error, lines } = this.current;
        return {
            id,
            name,
            status,
            queued,
            noCancel,
            queuedAt,
            startedAt,
            finishedAt,
            error,
            lines: lines.slice(-400),
            pending: this.pending,
        };
    }

    /**
     * One job by id, whether it is running now or finished recently.
     *
     * The UI learns that a job ended from a single event on the job stream, and
     * an event is only delivered once. If that stream drops and reconnects
     * across the moment a job finishes, the ending is gone -- `snapshot` only
     * replays a job that is still running, so a client that reconnects to an
     * idle queue is told nothing at all, and its overlay spins over work that
     * is long done. This lets it ask instead of waiting to be told.
     *
     * Bounded by the same ten-job history, so an id old enough to have fallen
     * out is null rather than an error: by then the answer is "not running",
     * which is all the caller needs.
     */
    find(id) {
        // Still waiting is an answer too. Without this a job lined up behind
        // another read as gone, and the page took "gone" to mean finished.
        const waiting = this.queue.find(({ job }) => job.id === id);
        if (waiting) {
            const { name, status, queuedAt, startedAt, finishedAt, error } = waiting.job;
            return { id, name, status, queuedAt, startedAt, finishedAt, error, lines: [], ahead: this.queue.indexOf(waiting) };
        }
        if (this.current?.id === id) {
            const { name, status, startedAt, finishedAt, error, lines } = this.current;
            return { id, name, status, startedAt, finishedAt, error, lines: lines.slice(-400) };
        }
        return this.history.find((job) => job.id === id) ?? null;
    }

    /** Everything the Update Queue page shows: running, waiting, and the last ten finished. */
    view() {
        return {
            current: this.busy ? this.snapshot() : null,
            pending: this.pending,
            history: this.history.map(
                ({ id, name, status, queued, queuedAt, startedAt, finishedAt, error, lines }) => ({
                    id,
                    name,
                    status,
                    queued,
                    queuedAt,
                    startedAt,
                    finishedAt,
                    error,
                    lines,
                }),
            ),
        };
    }
}

export const jobs = new JobRunner();

/**
 * Whether the job the calling code is running in has been asked to stop.
 *
 * Cancelling kills the processes running at that moment, which ends the step
 * in progress. A job made of several steps -- backing up one app after
 * another -- asks this between them, or it would carry on with the next.
 */
export function cancelRequested() {
    const id = jobContext.getStore()?.id;
    return Boolean(id && jobs.current?.id === id && jobs.current.cancelled);
}
