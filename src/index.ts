/**
 * Pulumi Automation API Entry Point (Orchestrator)
 *
 * Orchestrates infra-global, infra-region, infra-datastore, infra-cluster, and infra-services
 * layers in correct dependency order with optional parallelization and scoping.
 *
 * Usage:
 *   node index.js <preview|deploy|destroy> <env> [--scope <layers>] [--regions <regions>]
 *
 * Examples:
 *   node index.js deploy prd
 *   node index.js preview dev --scope infra-cluster,infra-services
 *   node index.js destroy val --regions us-west-2
 */
import * as pulumi from '@pulumi/pulumi';
import { InlineProgramArgs, LocalWorkspace } from '@pulumi/pulumi/automation';
import { createStack as createAcctStack } from './stacks/acct-baseline';
import { createStack as createFoundationStack } from './stacks/net-foundation';
import { createStack as createStatefulStack } from './stacks/stateful-data';
import { createStack as createPlatformStack } from './stacks/svc-platform';
import { createStack as createWorkloadsStack } from './stacks/workloads';

// --- Types & Constants ----------------------------------------------------------------

type PulumiAction = 'preview' | 'deploy' | 'destroy';
const PULUMI_PLUGIN_VERSION = 'v4.0.0';
const DEFAULT_REGION = 'us-east-1';
const SUPPORTED_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1'];

interface Layer {
    name: string;
    create: (stackName: string) => Promise<void>;
    getStacks: (env: string, regions: string[]) => string[];
}

const rolloutOrder: Layer[] = [
    {
        name: 'infra-global',
        create: async (stackName: string) => {
            await createAcctStack(stackName);
        },
        getStacks: (env) => [env],
    },
    {
        name: 'infra-region',
        create: async (stackName: string) => {
            await createFoundationStack(stackName);
        },
        getStacks: (env, regions) => regions.map((r) => `${r}-${env}`),
    },
    {
        name: 'infra-datastore',
        create: async (stackName: string) => {
            await createStatefulStack(stackName);
        },
        getStacks: (env, regions) => regions.map((r) => `${r}-${env}`),
    },
    {
        name: 'infra-cluster',
        create: async (stackName: string) => {
            await createPlatformStack(stackName);
        },
        getStacks: (env, regions) => regions.map((r) => `${r}-${env}`),
    },
    {
        name: 'infra-services',
        create: async (stackName: string) => {
            await createWorkloadsStack(stackName);
        },
        getStacks: (env, regions) => regions.map((r) => `${r}-${env}`),
    },
];

// --- Helpers ---------------------------------------------------------------------------

/** Validate action */
const validateAction = (action?: string): PulumiAction => {
    if (action === 'preview') return 'preview';
    if (action === 'deploy' || action === 'destroy') return action;
    throw new Error(`Invalid action: ${action}. Must be 'preview', 'deploy', or 'destroy'`);
};

/** Parse CLI args */
const parseArgs = () => {
    const raw = process.argv.slice(2);
    const action = validateAction(raw[0]);
    const env = raw[1] || process.env.NODE_ENV;
    if (!env) throw new Error('Environment not specified. Provide as second argument or NODE_ENV.');

    // flags
    const scopesFlag = raw.includes('--scope') ? raw[raw.indexOf('--scope') + 1].split(',') : [];
    const regionsFlag = raw.includes('--regions')
        ? raw[raw.indexOf('--regions') + 1].split(',')
        : SUPPORTED_REGIONS;

    return { action, env, scopes: scopesFlag, regions: regionsFlag };
};

/** Run Pulumi on one stack */
async function runOnStack(
    layerName: string,
    stackName: string,
    createFn: (stack: string) => Promise<void>,
    action: PulumiAction,
) {
    const projectName = layerName;
    pulumi.log.info(`› [${layerName}] preparing stack ${stackName}`);
    const args: InlineProgramArgs = {
        projectName,
        stackName,
        program: async () => createFn(stackName),
    };

    const stack = await LocalWorkspace.createOrSelectStack(args);
    await stack.setConfig('aws:region', { value: DEFAULT_REGION });
    await stack.workspace.installPlugin('aws', PULUMI_PLUGIN_VERSION);
    await stack.refresh({ onOutput: console.info, suppressProgress: true });

    const opts = {
        onOutput: console.info,
        suppressProgress: true,
        showSecrets: false,
        color: 'always' as const,
    };
    pulumi.log.info(`› [${layerName}:${stackName}] ${action}`);

    switch (action) {
        case 'preview': {
            await stack.preview(opts);
            break;
        }
        case 'deploy': {
            const res = await stack.up(opts);
            console.dir(res.summary, { depth: 4 });
            break;
        }
        case 'destroy': {
            await stack.destroy(opts);
            break;
        }
    }
}

// --- Orchestrator ----------------------------------------------------------------------

const run = async () => {
    const { action, env, scopes, regions } = parseArgs();
    const isDestroy = action === 'destroy';

    // Determine order
    const layers = isDestroy ? [...rolloutOrder].reverse() : rolloutOrder;

    for (const layer of layers) {
        if (scopes.length && !scopes.includes(layer.name)) continue;

        let stacks = layer.getStacks(env, regions);
        if (isDestroy) stacks = stacks.reverse();

        // Parallelize independent stacks
        await Promise.all(
            stacks.map((stackName) => runOnStack(layer.name, stackName, layer.create, action)),
        );
    }

    pulumi.log.info('✅ All operations completed');
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
