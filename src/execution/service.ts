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
import type {Executor} from '../executor.js';
import type {ScriptConfig, ServiceScriptConfig} from '../script.js';
import type {Logger} from '../logging/logger.js';
import type {Result} from '../error.js';

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
  static prepare(
    script: ServiceScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new ServiceExecution(script, executor, logger).#prepare();
  }

  #state: ServiceExecutionState = {state: 'initial'};

  /**
   * Resolves when this service has terminated for any reason.
   *
   * Consumers of this service should listen for this event, and consider it an
   * error if the service terminates before the consumer finished.
   */
  get terminated(): Promise<Result<void>> {
    return this.#terminated.promise;
  }
  readonly #terminated = new Deferred<Result<void>>();

  /**
   * Prepare to run, but don't actually run yet until a consumer calls
   * {@link start}.
   */
  async #prepare(): Promise<ExecutionResult> {
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

  /**
   * The first consumer who calls this function will trigger this service to
   * start running.
   */
  start(consumerDone: Promise<unknown>): Promise<Result<void>> {
    console.log(this.script.name, 'START', this.#state.state);
    switch (this.#state.state) {
      case 'awaiting-first-consumer': {
        const servicesStarted = [];
        for (const service of this.#state.services) {
          servicesStarted.push(service.start(this.terminated));
          void service.terminated.then(() => this.#onServiceTerminated());
        }
        const child = new Deferred<ScriptChildProcess>();
        this.#state = {
          state: 'starting',
          child,
          numConsumers: 0,
        };
        this.#registerConsumer(consumerDone);
        // TODO(aomarks) Errors?
        void Promise.all(servicesStarted).then(() =>
          this.#onAllServicesStarted()
        );
        return child.promise.then((child) => child.spawned);
      }
      case 'starting': {
        this.#registerConsumer(consumerDone);
        return this.#state.child.promise.then((child) => child.spawned);
      }
      case 'started': {
        this.#registerConsumer(consumerDone);
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
          // TODO(aomarks) It feels a little weird to "execute" this script, but
          // I'm pretty sure it's safe.
          const consumerResolved = this.executor.execute(consumer);
          void consumerResolved.then(() => this.#onConsumerTerminated());
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
          this.#terminated.resolve({ok: true, value: undefined});
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
          this.#terminated.resolve({
            ok: false,
            error: {
              script: this.script,
              type: 'failure',
              reason: 'service-terminated-unexpectedly',
            },
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

  #registerConsumer(_consumer: Promise<unknown>): void {
    console.log(this.script.name, 'REGISTER CONSUMER', this.#state.state);
    switch (this.#state.state) {
      case 'starting':
      case 'started': {
        // this.#state.numConsumers++;
        return;
      }
      case 'failed':
      case 'failing': {
        return;
      }
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

  #onConsumerTerminated(): void {
    console.log(this.script.name, 'CONSUMER TERMINATED', this.#state.state);
    switch (this.#state.state) {
      case 'started': {
        this.#state.numConsumers--;
        if (this.#state.numConsumers <= 0) {
          void this.#state.child.kill();
          this.#state = {state: 'stopping'};
        }
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
