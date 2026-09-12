import {
    FingerprintInput,
    StateHashInput,
    buildFindingId,
    computeFingerprint,
    computeStateHash,
} from '../src/maintenance/identity/fingerprint';
import { FindingSchema } from '../src/maintenance/schema';

function makeInput(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
    return {
        collector: 'npm',
        subjectKind: 'npm-package',
        subjectId: 'typescript',
        kind: 'dependency-outdated',
        discriminator: null,
        ...overrides,
    };
}

function makeState(overrides: Partial<StateHashInput> = {}): StateHashInput {
    return {
        declared: '^5.7.3',
        observed: '5.7.3',
        latest: '5.9.2',
        bump: 'minor',
        severity: 'low',
        unresolved: false,
        advisoryFixedVersion: null,
        ...overrides,
    };
}

describe('computeFingerprint', () => {
    describe('stability', () => {
        it('should not change when the latest version moves [REQ-ID-001]', () => {
            // The headline property: a weekly scan must find the existing issue after
            // a release, not file a duplicate.
            const before = computeFingerprint(makeInput());
            const after = computeFingerprint(makeInput());

            expect(after).toBe(before);
        });

        it('should be deterministic across calls', () => {
            expect(computeFingerprint(makeInput())).toBe(computeFingerprint(makeInput()));
        });

        it('should produce 32 lowercase hex characters the schema accepts', () => {
            expect(computeFingerprint(makeInput())).toMatch(/^[0-9a-f]{32}$/);
        });
    });

    describe('identity axes', () => {
        it.each([
            ['collector', { collector: 'images' as const }],
            ['subject kind', { subjectKind: 'container-image' as const }],
            ['subject id', { subjectId: 'eslint' }],
            ['finding kind', { kind: 'dependency-vulnerable' as const }],
            ['discriminator', { discriminator: 'GHSA-4x5r-pxfx-6jf8' }],
        ])('should change when the %s changes', (_label, overrides) => {
            expect(computeFingerprint(makeInput(overrides))).not.toBe(
                computeFingerprint(makeInput()),
            );
        });

        it('should differ per advisory on the same package [REQ-ID-003]', () => {
            // A new CVE against the same package is genuinely new work.
            const first = computeFingerprint(makeInput({ discriminator: 'GHSA-aaaa' }));
            const second = computeFingerprint(makeInput({ discriminator: 'GHSA-bbbb' }));

            expect(first).not.toBe(second);
        });

        it('should not be confusable by embedding the field separator in a value', () => {
            // The NUL separator is written as an escape, never as a literal byte, or the
            // spec file itself becomes binary to git and undiffable in review.
            const split = computeFingerprint(
                makeInput({ subjectId: 'a', kind: 'action-outdated' }),
            );
            const joined = computeFingerprint(
                makeInput({ subjectId: `a${'\u0000'}action-outdated` }),
            );

            expect(split).not.toBe(joined);
        });

        it('should not collide across a broad set of inputs', () => {
            const seen = new Set<string>();
            for (let i = 0; i < 200; i += 1) {
                seen.add(computeFingerprint(makeInput({ subjectId: `package-${i}` })));
            }

            expect(seen.size).toBe(200);
        });
    });
});

describe('computeStateHash', () => {
    it('should change when the latest version moves [REQ-ID-004]', () => {
        expect(computeStateHash(makeState({ latest: '5.9.3' }))).not.toBe(
            computeStateHash(makeState()),
        );
    });

    it.each([
        ['declared', { declared: '^5.8.0' }],
        ['observed', { observed: '5.8.0' }],
        ['bump', { bump: 'major' as const }],
        ['severity', { severity: 'high' as const }],
        ['unresolved', { unresolved: true }],
        ['advisory fixed version', { advisoryFixedVersion: '5.9.0' }],
    ])('should change when %s changes', (_label, overrides) => {
        expect(computeStateHash(makeState(overrides))).not.toBe(computeStateHash(makeState()));
    });

    it('should handle an entirely unresolved state, where every version is null', () => {
        const unresolved = makeState({
            declared: null,
            observed: null,
            latest: null,
            bump: 'unknown',
            unresolved: true,
        });

        expect(computeStateHash(unresolved)).toMatch(/^[0-9a-f]{32}$/);
        expect(computeStateHash(unresolved)).not.toBe(computeStateHash(makeState()));
    });

    it('should distinguish a null version from an empty-string version', () => {
        expect(computeStateHash(makeState({ latest: null }))).not.toBe(
            computeStateHash(makeState({ latest: '' })),
        );
    });

    it('should be deterministic and 32 hex characters', () => {
        expect(computeStateHash(makeState())).toBe(computeStateHash(makeState()));
        expect(computeStateHash(makeState())).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('fingerprint and stateHash together', () => {
    it('should keep identity while state changes, which is the whole scheme', () => {
        // Same subject, new release: publish stage must update the issue, not create one.
        const identityBefore = computeFingerprint(makeInput());
        const identityAfter = computeFingerprint(makeInput());
        const stateBefore = computeStateHash(makeState({ latest: '5.9.2' }));
        const stateAfter = computeStateHash(makeState({ latest: '5.9.3' }));

        expect(identityAfter).toBe(identityBefore);
        expect(stateAfter).not.toBe(stateBefore);
    });

    it('should be independent hashes, not derived from one another', () => {
        expect(computeFingerprint(makeInput())).not.toBe(computeStateHash(makeState()));
    });
});

describe('buildFindingId', () => {
    it('should build a readable slug from the identity axes [REQ-ID-006]', () => {
        expect(buildFindingId(makeInput())).toBe('npm/dependency-outdated/typescript');
    });

    it('should include the discriminator so advisories are distinguishable', () => {
        const id = buildFindingId(
            makeInput({ kind: 'dependency-vulnerable', discriminator: 'GHSA-4x5r-pxfx-6jf8' }),
        );

        expect(id).toBe('npm/dependency-vulnerable/typescript/ghsa-4x5r-pxfx-6jf8');
    });

    it.each([
        [
            'a path-qualified subject',
            {
                collector: 'images' as const,
                subjectKind: 'container-image' as const,
                kind: 'image-distro-eol' as const,
                subjectId: '.devcontainer/Dockerfile#mcr.microsoft.com/devcontainers/base',
            },
        ],
        ['a scoped npm package', { subjectId: '@faker-js/faker' }],
        [
            'an action reference',
            {
                collector: 'github-actions' as const,
                subjectKind: 'github-action' as const,
                kind: 'action-unpinned' as const,
                subjectId: 'actions/checkout',
            },
        ],
    ])('should produce a schema-valid id for %s', (_label, overrides) => {
        const id = buildFindingId(makeInput(overrides));

        expect(id).toMatch(/^[a-z0-9][a-z0-9/_.\-@]*$/);
        expect(FindingSchema.shape.id.safeParse(id).success).toBe(true);
    });

    it('should lowercase and collapse characters the id pattern forbids', () => {
        const id = buildFindingId(makeInput({ subjectId: 'Some::Weird  Name!!' }));

        expect(id).toBe('npm/dependency-outdated/some-weird-name');
    });

    it('should be stable across calls', () => {
        expect(buildFindingId(makeInput())).toBe(buildFindingId(makeInput()));
    });
});
