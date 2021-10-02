import * as Rx from 'rxjs';
import { defaultIfEmpty, delay, filter, mapTo, skip, take, takeWhile } from 'rxjs/operators';

import { Command } from '../command';
import { defaults } from '../defaults';
import { Logger } from '../logger';
import { FlowController } from './flow-controller';


interface RestartProcessParams {
    logger?: Logger;
    delay?: number;
    tries?: number;
    scheduler?: Rx.SchedulerLike;
}

export class RestartProcess implements FlowController {
    private readonly logger: Logger;
    private readonly delay: number;
    private readonly tries: number;
    private readonly scheduler?: Rx.SchedulerLike;

    constructor({ delay, tries, logger, scheduler }: RestartProcessParams) {
        this.logger = logger;
        this.delay = +delay || defaults.restartDelay;
        this.tries = +tries || defaults.restartTries;
        this.tries = this.tries < 0 ? Infinity : this.tries;
        this.scheduler = scheduler;
    }

    handle(commands: Command[]) {
        if (this.tries === 0) {
            return { commands };
        }

        commands.map(command => command.close.pipe(
            take(this.tries),
            takeWhile(({ exitCode }) => exitCode !== 0)
        )).map((failure, index) => Rx.merge(
            // Delay the emission (so that the restarts happen on time),
            // explicitly telling the subscriber that a restart is needed
            failure.pipe(delay(this.delay, this.scheduler), mapTo(true)),
            // Skip the first N emissions (as these would be duplicates of the above),
            // meaning it will be empty because of success, or failed all N times,
            // and no more restarts should be attempted.
            failure.pipe(skip(this.tries), defaultIfEmpty(false))
        ).subscribe(restart => {
            const command = commands[index];
            if (restart) {
                this.logger.logCommandEvent(`${command.command} restarted`, command);
                command.start();
            }
        }));

        return {
            commands: commands.map(command => {
                const closeStream = command.close.pipe(filter(({ exitCode }, emission) => {
                    // We let all success codes pass, and failures only after restarting won't happen again
                    return exitCode === 0 || emission >= this.tries;
                }));

                return new Proxy(command, {
                    get(target, prop) {
                        return prop === 'close' ? closeStream : target[prop];
                    }
                });
            })
        };
    }
};
