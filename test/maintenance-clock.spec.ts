import { Clock, FixedClock, SystemClock, daysUntil } from '../src/maintenance/clock';

describe('SystemClock', () => {
    describe('now', () => {
        it('should return the current time', () => {
            const before = Date.now();
            const observed = new SystemClock().now().getTime();

            expect(observed).toBeGreaterThanOrEqual(before);
            expect(observed).toBeLessThanOrEqual(Date.now());
        });
    });

    describe('nowIso', () => {
        it('should emit a UTC ISO-8601 string with milliseconds and no offset', () => {
            expect(new SystemClock().nowIso()).toMatch(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            );
        });
    });

    describe('monotonicMs', () => {
        it('should not decrease between calls [REQ-RPT-005]', () => {
            const clock = new SystemClock();
            const first = clock.monotonicMs();

            expect(clock.monotonicMs()).toBeGreaterThanOrEqual(first);
        });
    });
});

describe('FixedClock', () => {
    describe('now', () => {
        it('should stay frozen across calls so reports are reproducible [REQ-RPT-004]', () => {
            const clock = new FixedClock('2026-09-12T06:00:00.000Z');

            expect(clock.nowIso()).toBe('2026-09-12T06:00:00.000Z');
            expect(clock.nowIso()).toBe('2026-09-12T06:00:00.000Z');
        });

        it('should accept a Date, a string or epoch millis', () => {
            expect(new FixedClock(new Date('2026-01-02T03:04:05.000Z')).nowIso()).toBe(
                '2026-01-02T03:04:05.000Z',
            );
            expect(new FixedClock('2026-01-02T03:04:05.000Z').nowIso()).toBe(
                '2026-01-02T03:04:05.000Z',
            );
            expect(new FixedClock(Date.UTC(2026, 0, 2, 3, 4, 5)).nowIso()).toBe(
                '2026-01-02T03:04:05.000Z',
            );
        });

        it('should reject an instant it cannot parse', () => {
            expect(() => new FixedClock('not a date')).toThrow(RangeError);
        });

        it('should return a fresh Date each call so callers cannot mutate it', () => {
            const clock = new FixedClock();
            const first = clock.now();
            first.setUTCFullYear(1999);

            expect(clock.now().getUTCFullYear()).toBe(2026);
        });
    });

    describe('monotonicMs', () => {
        it('should start at zero and track advances exactly [REQ-RPT-005]', () => {
            const clock = new FixedClock();

            expect(clock.monotonicMs()).toBe(0);
            clock.advance(1500);
            expect(clock.monotonicMs()).toBe(1500);
        });
    });

    describe('advance', () => {
        it('should move wall-clock and monotonic time together', () => {
            const clock = new FixedClock('2026-09-12T06:00:00.000Z');
            clock.advance(60_000);

            expect(clock.nowIso()).toBe('2026-09-12T06:01:00.000Z');
            expect(clock.monotonicMs()).toBe(60_000);
        });

        it('should advance whole days', () => {
            const clock = new FixedClock('2026-09-12T06:00:00.000Z');
            clock.advanceDays(30);

            expect(clock.nowIso()).toBe('2026-10-12T06:00:00.000Z');
        });

        it('should refuse to move backwards', () => {
            expect(() => new FixedClock().advance(-1)).toThrow(RangeError);
        });
    });
});

describe('daysUntil', () => {
    const clock: Clock = new FixedClock('2026-09-12T06:00:00.000Z');

    it.each([
        ['a future date', '2026-10-12', 30],
        ['tomorrow', '2026-09-13', 1],
        ['today', '2026-09-12', 0],
        ['yesterday', '2026-09-11', -1],
        ['a lapsed support date', '2026-08-31', -12],
    ])('should count %s as %s days', (_label, date: string, expected: number) => {
        expect(daysUntil(clock, date)).toBe(expected);
    });

    it('should not depend on the time of day the scan runs [REQ-RPT-004]', () => {
        const earlyRun = new FixedClock('2026-09-12T00:30:00.000Z');
        const lateRun = new FixedClock('2026-09-12T23:30:00.000Z');

        expect(daysUntil(earlyRun, '2026-11-26')).toBe(daysUntil(lateRun, '2026-11-26'));
    });

    it('should accept a Date as well as a string', () => {
        expect(daysUntil(clock, new Date('2026-09-22T00:00:00.000Z'))).toBe(10);
    });

    it('should reject a date it cannot parse', () => {
        expect(() => daysUntil(clock, 'not a date')).toThrow(RangeError);
    });
});
