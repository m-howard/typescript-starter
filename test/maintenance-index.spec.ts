import * as maintenance from '../src/maintenance';

/**
 * The barrel is the public surface for anything embedding the scan rather than running
 * the CLI. A name missing from it is a real defect that nothing else notices — every
 * internal module imports by path, so the barrel can rot without a single test failing.
 */
describe('src/maintenance barrel', () => {
    it.each([
        ['the contract', 'MaintenanceReportSchema'],
        ['the finding schema', 'FindingSchema'],
        ['the pass-2 contract', 'EnrichedFindingSchema'],
        ['the runner', 'runCollectors'],
        ['the config loader', 'loadConfig'],
        ['identity', 'computeFingerprint'],
        ['severity', 'computeSeverity'],
        ['the source registry', 'buildDefaultSourceRegistry'],
    ])('should export %s', (_label: string, name: string) => {
        expect(maintenance).toHaveProperty(name);
    });

    it.each([
        ['npm', 'NpmCollector'],
        ['github-actions', 'GithubActionsCollector'],
        ['arc', 'ArcCollector'],
        ['eks', 'EksCollector'],
        ['images', 'ImagesCollector'],
    ])('should export the %s collector', (_label: string, name: string) => {
        expect(maintenance).toHaveProperty(name);
    });

    it.each([
        ['file provider', 'LocalFsProvider'],
        ['http client', 'FetchHttpClient'],
        ['offline http client', 'OfflineHttpClient'],
        ['command runner', 'ExecFileCommandRunner'],
        ['offline command runner', 'OfflineCommandRunner'],
        ['clock', 'SystemClock'],
    ])('should export the %s seam', (_label: string, name: string) => {
        expect(maintenance).toHaveProperty(name);
    });

    it('should not leak the CLI, so importing the library runs no argument parsing', () => {
        expect(maintenance).not.toHaveProperty('parseCliOptions');
    });
});
