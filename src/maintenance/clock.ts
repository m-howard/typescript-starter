/**
 * Injectable time source.
 *
 * Severity depends on how many days remain before an end-of-support date, and the
 * report records when it was generated and how long each collector took. Reading the
 * system clock directly would make the severity specs rot as those dates pass, and
 * would make reports irreproducible (REQ-SEV-005, REQ-RPT-004, REQ-RPT-005).
 */

/** Milliseconds in a day, used for end-of-support arithmetic. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface Clock {
    /** Current wall-clock time. */
    now(): Date;
    /** Current wall-clock time as a UTC ISO-8601 string, e.g. `2026-09-12T06:00:00.000Z`. */
    nowIso(): string;
    /**
     * A monotonically non-decreasing millisecond counter for measuring elapsed time.
     *
     * Separate from {@link now} because wall-clock time can jump backwards, which would
     * produce negative durations in the report.
     */
    monotonicMs(): number;
}

/** The real clock. */
export class SystemClock implements Clock {
    public now(): Date {
        return new Date();
    }

    public nowIso(): string {
        return this.now().toISOString();
    }

    public monotonicMs(): number {
        return performance.now();
    }
}

/**
 * A clock frozen at a fixed instant, for tests.
 *
 * Wall-clock and monotonic time advance together via {@link advance}, so a spec can
 * assert an exact `durationMs` as well as an exact `generatedAt`.
 */
export class FixedClock implements Clock {
    private currentMs: number;
    private readonly startedAtMs: number;

    constructor(instant: Date | string | number = '2026-09-12T06:00:00.000Z') {
        this.currentMs = FixedClock.toMillis(instant);
        this.startedAtMs = this.currentMs;
    }

    public now(): Date {
        return new Date(this.currentMs);
    }

    public nowIso(): string {
        return this.now().toISOString();
    }

    public monotonicMs(): number {
        return this.currentMs - this.startedAtMs;
    }

    /** Move both wall-clock and monotonic time forward. */
    public advance(milliseconds: number): void {
        if (milliseconds < 0) {
            throw new RangeError(`Cannot advance a clock by a negative amount: ${milliseconds}`);
        }
        this.currentMs += milliseconds;
    }

    /** Move both wall-clock and monotonic time forward by whole days. */
    public advanceDays(days: number): void {
        this.advance(days * MS_PER_DAY);
    }

    private static toMillis(instant: Date | string | number): number {
        const millis = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
        if (Number.isNaN(millis)) {
            throw new RangeError(`Not a valid instant: ${String(instant)}`);
        }
        return millis;
    }
}

/**
 * Whole days from `clock`'s current time until `date`, negative once it has passed.
 *
 * Both sides are truncated to UTC midnight before subtracting, so the result does not
 * shift with the time of day a scan happens to run — a scan at 23:00 and one at 01:00
 * must agree on how many days remain.
 */
export function daysUntil(clock: Clock, date: Date | string): number {
    const target = date instanceof Date ? date : new Date(date);
    const targetMs = target.getTime();
    if (Number.isNaN(targetMs)) {
        throw new RangeError(`Not a valid date: ${String(date)}`);
    }
    return Math.round((utcMidnight(targetMs) - utcMidnight(clock.now().getTime())) / MS_PER_DAY);
}

/** Truncate an instant to UTC midnight of the same calendar day. */
function utcMidnight(millis: number): number {
    return Math.floor(millis / MS_PER_DAY) * MS_PER_DAY;
}
