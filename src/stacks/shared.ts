/**
 * Shared stack utilities - Stack-name parsing and standard tagging used across every layer.
 *
 * Regional stacks are named `<region>-<env>` (e.g. `us-east-1-prd`) while the global account
 * stack is named `<env>`. These helpers turn that convention into structured values and a
 * consistent tag set so cost tracking and ownership are uniform across layers.
 */

/** Parsed identity of a stack. */
export interface StackIdentity {
    /** Deployment environment (dev, val, prd) */
    env: string;
    /** AWS region, or undefined for the global account layer */
    region?: string;
}

const KNOWN_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1'];

/**
 * Parse a stack name into its environment and (optional) region.
 *
 * @param stackName - Either `<env>` (global) or `<region>-<env>` (regional).
 */
export function parseStackName(stackName: string): StackIdentity {
    for (const region of KNOWN_REGIONS) {
        if (stackName.startsWith(`${region}-`)) {
            return { region, env: stackName.slice(region.length + 1) };
        }
    }
    return { env: stackName };
}

/**
 * Build the standard tag set applied to every resource in a layer.
 *
 * @param layer - Layer identifier (e.g. `stateful-data`).
 * @param identity - Parsed {@link StackIdentity}.
 */
export function standardTags(layer: string, identity: StackIdentity): { [key: string]: string } {
    const tags: { [key: string]: string } = {
        env: identity.env,
        layer,
        team: 'platform',
        costCentre: 'docs-knowledge-base',
    };
    if (identity.region) {
        tags.region = identity.region;
    }
    return tags;
}

/**
 * Titan V2 text embedding model, referenced by family alias rather than a frozen version so the
 * KB is not stranded on a legacy Extended-Access tier. Region is substituted at use.
 */
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
