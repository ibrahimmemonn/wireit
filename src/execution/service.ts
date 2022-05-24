/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {ScriptChildProcess} from '../script-child-process.js';
import {Deferred} from '../util/deferred.js';

import type {ExecutionResult} from './base.js';
import type {ScriptConfig, ServiceScriptConfig} from '../script.js';
import type {Result} from '../error.js';
import type {Failure} from '../event.js';

/**
 * Possible states of a {@link ServiceExecution}.
 */
type ServiceExecutionState =
  | {state: 'initial'}
  | {state: 'fingerprinting'}
  | {
      state: 'awaiting-first-consumer';
      services: ServiceExecution[];
    }
  | {
      state: 'starting';
      child: Deferred<ScriptChildProcess>;
      numConsumers: number;
    }
  | {
      state: 'started';
      child: ScriptChildProcess;
      numConsumers: number;
    }
  | {state: 'stopping'}
  | {state: 'stopped'}
  | {state: 'failing'}
  | {state: 'failed'};

const unknownState = (state: never) => {
  throw new Error(`Unknown service state ${JSON.stringify(state)}`);
};

const unexpectedState = (state: ServiceExecutionState) => {
  throw new Error(`Unexpected service state ${state.state}`);
};

/**
 * Execution for a {@link ServiceScriptConfig}.
 */
export class ServiceExecution extends BaseExecution<ServiceScriptConfig> {
  #state: ServiceExecutionState = {state: 'initial'};

  readonly #done = new Deferred<Result<void, Failure[]>>();
  override get done() {
    return this.#done.promise;
  }

  /**
   * Prepare to run, but don't actually run yet until a consumer calls
   * {@link start}.
   */
  async execute(): Promise<ExecutionResult> {
    console.log(this.script.name, 'EXECUTE', this.#state.state);
    switch (this.#state.state) {
      case 'initial': {
        this.#state = {state: 'fingerprinting'};
        const dependencyResults = await this.executeDependencies();
        if (!dependencyResults.ok) {
          return dependencyResults;
        }
        const fingerprint = await Fingerprint.compute(
          this.script,
          dependencyResults.value
        );
        const services = [];
        for (const [, result] of dependencyResults.value) {
          for (const service of result.services) {
            services.push(service);
          }
        }
        if (this.#state.state !== 'fingerprinting') {
          throw unexpectedState(this.#state);
        }
        this.#state = {
          state: 'awaiting-first-consumer',
          services,
        };
        return {ok: true, value: {fingerprint, services: [this]}};
      }
      case 'awaiting-first-consumer':
      case 'starting':
      case 'started':
      case 'fingerprinting':
      case 'stopping':
      case 'stopped':
      case 'failing':
      case 'failed': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  /**
   * Find the scripts that may need this service to start.
   *
   * Accounts for the fact that we need to walk through no-op scripts, because
   * if a script A depends on no-op script B, and B depends on service C, then A
   * depends on service C.
   */
  #findConsumersOfThisService(): ScriptConfig[] {
    if (this.script.reverseDependencies.length === 0) {
      return [];
    }
    const consumers = new Set<ScriptConfig>();
    const stack: ScriptConfig[] = [this.script];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const current = stack.pop()!;
      for (const {config} of current.reverseDependencies) {
        const isNoOp = config.command === undefined;
        if (isNoOp) {
          stack.push(config);
        } else {
          consumers.add(config);
        }
      }
    }
    return [...consumers];
  }

  #numConsumers = 0;

  /**
   * Prevent this service from stopping after it is started, until
   * {@link unimmortalize} is called.
   */
  addConsumer(releaseConsumer: Promise<unknown>): void {
    console.log(this.script.name, 'ADD CONSUMER', this.#state.state);
    this.#numConsumers++;
    void releaseConsumer
      .catch(() => undefined)
      .then(() => {
        this.#numConsumers--;
        if (this.#numConsumers <= 0) {
          this.#onAllConsumersReleased();
        }
      });
  }

  /**
   * The first consumer who calls this function will trigger this service to
   * start running.
   */
  start(): Promise<Result<void>> {
    console.log(this.script.name, 'START', this.#state.state);
    switch (this.#state.state) {
      case 'awaiting-first-consumer': {
        const servicesStarted = [];
        for (const service of this.#state.services) {
          servicesStarted.push(service.start());
          void service.done.then(() => this.#onServiceTerminated());
        }
        const child = new Deferred<ScriptChildProcess>();
        this.#state = {
          state: 'starting',
          child,
          numConsumers: 0,
        };
        // this.#registerConsumer(consumerDone);
        // TODO(aomarks) Errors?
        void Promise.all(servicesStarted).then(() =>
          this.#onAllServicesStarted()
        );
        return child.promise.then((child) => child.spawned);
      }
      case 'starting': {
        // this.#registerConsumer(consumerDone);
        return this.#state.child.promise.then((child) => child.spawned);
      }
      case 'started': {
        // this.#registerConsumer(consumerDone);
        return this.#state.child.spawned;
      }
      case 'initial':
      case 'fingerprinting':
      case 'stopping':
      case 'stopped':
      case 'failing':
      case 'failed': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onAllServicesStarted(): void {
    console.log(this.script.name, 'ALL SERVICES STARTED', this.#state.state);
    switch (this.#state.state) {
      case 'starting': {
        const child = new ScriptChildProcess(this.script);
        this.#state.child.resolve(child);

        const consumers = this.#findConsumersOfThisService();
        for (const consumer of consumers) {
          this.addConsumer(this.executor.getExecution(consumer).done);
        }

        this.#state = {
          state: 'started',
          child,
          numConsumers: consumers.length,
        };

        child.stdout.on('data', (data: string | Buffer) => {
          this.logger.log({
            script: this.script,
            type: 'output',
            stream: 'stdout',
            data,
          });
        });

        child.stderr.on('data', (data: string | Buffer) => {
          this.logger.log({
            script: this.script,
            type: 'output',
            stream: 'stderr',
            data,
          });
        });

        void child.completed.then((result) => this.#onChildTerminated(result));

        return;
      }
      case 'stopped':
      case 'failed': {
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'awaiting-first-consumer':
      case 'started':
      case 'stopping':
      case 'failing': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onServiceTerminated(): void {
    console.log(this.script.name, 'SERVICE TERMINATED', this.#state.state);
    switch (this.#state.state) {
      case 'starting': {
        this.#state = {state: 'failed'};
        this.#done.resolve({
          ok: false,
          error: [
            {
              type: 'failure',
              script: this.script,
              reason: 'unknown-error-thrown',
              error: 'TODO',
            },
          ],
        });
        return;
      }
      case 'started': {
        this.#state.child.kill();
        this.#state = {state: 'failing'};
        return;
      }
      case 'failing':
      case 'failed':
      case 'stopping':
      case 'stopped': {
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'awaiting-first-consumer': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onChildTerminated(result: Awaited<ScriptChildProcess['completed']>): void {
    console.log(this.script.name, 'CHILD TERMINATED', this.#state.state);
    switch (this.#state.state) {
      case 'started':
      case 'stopping':
      case 'failing': {
        if (
          this.#state.state === 'stopping' &&
          !result.ok &&
          result.error.reason === 'killed'
        ) {
          // The contract for a service is that it runs indefinitely, so it
          // should only ever terminate because it was killed. Anything else is
          // an unexpected termination.
          this.#state = {state: 'stopped'};
          this.#done.resolve({ok: true, value: undefined});
          this.logger.log({
            script: this.script,
            type: 'success',
            reason: 'service-stopped',
          });
        } else {
          // TODO(aomarks) If we killed because a service failed, we should have
          // a different error message. The same one as if that happens to a
          // one-shot. Or maybe it should actually be the propagated failure
          // error somehow.
          this.#state = {state: 'failed'};
          this.#done.resolve({
            ok: false,
            error: [
              {
                type: 'failure',
                script: this.script,
                reason: 'unknown-error-thrown',
                error: 'TODO',
              },
            ],
          });
        }
        return;
      }
      case 'initial':
      case 'fingerprinting':
      case 'awaiting-first-consumer':
      case 'starting':
      case 'stopped':
      case 'failed': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }

  #onAllConsumersReleased(): void {
    console.log(this.script.name, 'ALL CONSUMERS RELEASED', this.#state.state);
    switch (this.#state.state) {
      case 'started': {
        void this.#state.child.kill();
        this.#state = {state: 'stopping'};
        return;
      }
      case 'failed':
      case 'failing': {
        return;
      }
      case 'starting':
      case 'initial':
      case 'fingerprinting':
      case 'awaiting-first-consumer':
      case 'stopping':
      case 'stopped': {
        throw unexpectedState(this.#state);
      }
      default: {
        throw unknownState(this.#state);
      }
    }
  }
}
