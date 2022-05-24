/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NoOpExecution} from './execution/no-op.js';
import {OneShotExecution} from './execution/one-shot.js';
import {ServiceExecution} from './execution/service.js';
import {
  ScriptConfig,
  ScriptReferenceString,
  scriptReferenceToString,
  ServiceScriptConfig,
} from './script.js';
import {WorkerPool} from './util/worker-pool.js';
import {Deferred} from './util/deferred.js';
import {aggregateFailures, convertExceptionToFailure, Result} from './error.js';

import type {ExecutionResult} from './execution/base.js';
import type {Logger} from './logging/logger.js';
import type {Cache} from './caching/cache.js';
import {Failure} from './event.js';

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

type Execution = NoOpExecution | OneShotExecution | ServiceExecution;

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  readonly #executionResults = new Map<string, Promise<ExecutionResult>>();
  readonly #executions = new Map<ScriptReferenceString, Execution>();
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #cache?: Cache;

  /** Resolves when the first failure occurs in any script. */
  readonly #failureOccured = new Deferred<void>();
  /** Resolves when we decide that new scripts should not be started. */
  readonly #stopStartingNewScripts = new Deferred<void>();
  /** Resolves when we decide that running scripts should be killed. */
  readonly #killRunningScripts = new Deferred<void>();
  /** Resolves when we decide that top-level services should be killed. */
  readonly #killTopLevelServices = new Deferred<void>();

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>
  ) {
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#cache = cache;

    // If this entire execution is aborted because e.g. the user sent a SIGINT
    // to the Wireit process, then dont start new scripts, and kill running
    // ones.
    void abort.promise.then(() => {
      this.#stopStartingNewScripts.resolve();
      this.#killRunningScripts.resolve();
      this.#killTopLevelServices.resolve();
    });

    // If a failure occurs, then whether we stop starting new scripts or kill
    // running ones depends on the failure mode setting.
    void this.#failureOccured.promise.then(() => {
      switch (failureMode) {
        case 'continue': {
          break;
        }
        case 'no-new': {
          this.#stopStartingNewScripts.resolve();
          break;
        }
        case 'kill': {
          this.#stopStartingNewScripts.resolve();
          this.#killRunningScripts.resolve();
          break;
        }
        default: {
          const never: never = failureMode;
          throw new Error(
            `Internal error: unexpected failure mode: ${String(never)}`
          );
        }
      }
    });
  }

  /**
   * Signal that a script has failed, which will potentially stop starting or
   * kill other scripts depending on the {@link FailureMode}.
   *
   * This method will be called automatically in the normal flow of execution,
   * but scripts can also call it directly to synchronously signal a failure.
   */
  notifyFailure(): void {
    this.#failureOccured.resolve();
  }

  killTopLevelServices(): void {
    console.log('KILL TOP LEVEL');
    this.#killTopLevelServices.resolve();
  }

  /**
   * Synchronously check if new scripts should stop being started.
   */
  get shouldStopStartingNewScripts(): boolean {
    return this.#stopStartingNewScripts.settled;
  }

  /**
   * A promise which resolves if we should kill running scripts.
   */
  get shouldKillRunningScripts(): Promise<void> {
    return this.#killRunningScripts.promise;
  }

  async executeTopLevel(
    script: ScriptConfig
  ): Promise<Result<void, Failure[]>> {
    const servicesDone = [];
    for (const config of this.findTopLevelServices(script)) {
      const execution = this.getExecution(config);
      execution.addConsumer(this.#killTopLevelServices.promise);
      void this.execute(script).then(() => {
        void execution.start();
      });
      servicesDone.push(execution.done);
      void execution.done.then((result) => {
        if (!result.ok) {
          this.notifyFailure();
        }
      });
    }
    const result = await this.execute(script);
    if (!result.ok) {
      const services = await Promise.all(servicesDone);
      const agg = aggregateFailures(services);
      if (!agg.ok) {
        for (const failure of agg.error) {
          result.error.push(failure);
        }
      }
      return result;
    }
    const services = await Promise.all(servicesDone);
    const agg = aggregateFailures(services);
    return agg;
  }

  findTopLevelServices(
    script: ScriptConfig,
    services = new Set<ServiceScriptConfig>()
  ): Set<ServiceScriptConfig> {
    if (script.command === undefined) {
      for (const dep of script.dependencies) {
        this.findTopLevelServices(dep.config, services);
      }
    } else if (script.service) {
      services.add(script);
    }
    return services;
  }

  async execute(script: ScriptConfig): Promise<ExecutionResult> {
    const executionKey = scriptReferenceToString(script);
    let promise = this.#executionResults.get(executionKey);
    if (promise === undefined) {
      const execution = this.getExecution(script);
      let p;
      if (execution instanceof OneShotExecution) {
        p = execution.execute();
      } else if (execution instanceof NoOpExecution) {
        p = execution.fingerprint();
      } else if (execution instanceof ServiceExecution) {
        p = execution.fingerprint();
      } else {
        const never: never = execution;
        throw new Error(
          `Unknown execution type ${(never as object).constructor.name}`
        );
      }
      promise = p
        .catch((error) => convertExceptionToFailure(error, script))
        .then((result) => {
          if (!result.ok) {
            this.notifyFailure();
          } else {
            // TODO(aomarks) Handle errors here. Done should have the error.
            //
            // for (const service of result.value.services) {
            //   void service.done.then((result) => {
            //     if (!result.ok) {
            //       this.notifyFailure();
            //     }
            //   });
            // }
          }
          return result;
        });
      this.#executionResults.set(executionKey, promise);
    }
    return promise;
  }

  getExecution(script: ServiceScriptConfig): ServiceExecution;
  getExecution(script: ScriptConfig): Execution;
  getExecution(script: ScriptConfig): Execution {
    const executionKey = scriptReferenceToString(script);
    let execution = this.#executions.get(executionKey);
    if (execution === undefined) {
      execution = this.#makeExecutionAccordingToKind(script);
      this.#executions.set(executionKey, execution);
    }
    return execution;
  }

  #makeExecutionAccordingToKind(script: ScriptConfig): Execution {
    if (script.command === undefined) {
      return new NoOpExecution(script, this, this.#logger);
    }
    if (script.service) {
      return new ServiceExecution(script, this, this.#logger);
    }
    return new OneShotExecution(
      script,
      this,
      this.#workerPool,
      this.#cache,
      this.#logger
    );
  }
}
