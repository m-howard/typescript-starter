/**
 * Bounding text that comes from somewhere else.
 *
 * A finding title is capped at 160 characters by the contract, and an evidence snippet
 * at 400. Both are routinely built from text this project does not control — an advisory
 * title, a line of a Dockerfile — so the cap has to be applied rather than assumed. A
 * finding rejected at validation for a long advisory title would lose the whole finding,
 * which is a far worse outcome than a shortened title.
 */

/** Shorten to at most `maxLength` characters, marking that something was cut. */
export function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
