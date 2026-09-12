/**
 * The collectors and the machinery they share.
 *
 * Every collector goes through `buildFinding`, so identity, severity and the contract
 * check are computed the same way whatever surface is being examined.
 */

export * from './build-finding';
export * from './collector';
export * from './github-actions';
export * from './images';
export * from './npm';
