/**
 * The offline command runner: nothing is executed.
 *
 * Every command the collect stage runs — `npm outdated`, `npm audit`, `aws eks
 * describe-cluster-versions` — reaches the network, so offline mode has to stop them as
 * surely as it stops HTTP requests. Enforcing it at the seam rather than in each
 * collector is what makes REQ-NET-020 true by construction: a collector added later
 * cannot forget to check, and there is no code path where `--offline` half-applies.
 *
 * The refusal is a normal classified failure, so each collector degrades the way it
 * already does when the binary is missing — findings from its remaining inputs, an
 * error recorded, and a run status that says the picture is incomplete.
 */

import { OfflineError } from '../errors';
import { CommandRequest, CommandResult, CommandRunner } from './command-runner';

export class OfflineCommandRunner implements CommandRunner {
    public run(request: CommandRequest): Promise<CommandResult> {
        return Promise.reject(
            new OfflineError(
                `${request.argv.join(' ')} was not run: offline mode is active and this ` +
                    'command reaches the network.',
            ),
        );
    }
}
