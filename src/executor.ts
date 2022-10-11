/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NoCommandScriptExecution} from './execution/no-command.js';
import {StandardScriptExecution} from './execution/standard.js';
import {ServiceFingerprinter} from './execution/service.js';
import {ScriptConfig, scriptReferenceToString} from './config.js';
import {WorkerPool} from './util/worker-pool.js';
import {Deferred} from './util/deferred.js';
import {convertExceptionToFailure} from './error.js';

import type {ExecutionResult} from './execution/base.js';
import type {Logger} from './logging/logger.js';
import type {Cache} from './caching/cache.js';

/**
 * What to do when a script failure occurs:
 *
 * - `no-new`: Allow running scripts to finish, but don't start new ones.
 * - `continue`: Allow running scripts to finish, and start new ones unless a
 *   dependency failed.
 * - `kill`: Immediately kill running scripts, and don't start new ones.
 */
export type FailureMode = 'no-new' | 'continue' | 'kill';

/**
 * Executes a script that has been analyzed and validated by the Analyzer.
 */
export class Executor {
  private readonly _executions = new Map<string, Promise<ExecutionResult>>();
  private readonly _logger: Logger;
  private readonly _workerPool: WorkerPool;
  private readonly _cache?: Cache;

  /** Resolves when the first failure occurs in any script. */
  private readonly _failureOccured = new Deferred<void>();
  /** Resolves when we decide that new scripts should not be started. */
  private readonly _stopStartingNewScripts = new Deferred<void>();
  /** Resolves when we decide that running scripts should be killed. */
  private readonly _killRunningScripts = new Deferred<void>();

  constructor(
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>
  ) {
    this._logger = logger;
    this._workerPool = workerPool;
    this._cache = cache;

    // If this entire execution is aborted because e.g. the user sent a SIGINT
    // to the Wireit process, then dont start new scripts, and kill running
    // ones.
    void abort.promise.then(() => {
      this._stopStartingNewScripts.resolve();
      this._killRunningScripts.resolve();
    });

    // If a failure occurs, then whether we stop starting new scripts or kill
    // running ones depends on the failure mode setting.
    void this._failureOccured.promise.then(() => {
      switch (failureMode) {
        case 'continue': {
          break;
        }
        case 'no-new': {
          this._stopStartingNewScripts.resolve();
          break;
        }
        case 'kill': {
          this._stopStartingNewScripts.resolve();
          this._killRunningScripts.resolve();
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
    this._failureOccured.resolve();
  }

  /**
   * Synchronously check if new scripts should stop being started.
   */
  get shouldStopStartingNewScripts(): boolean {
    return this._stopStartingNewScripts.settled;
  }

  /**
   * A promise which resolves if we should kill running scripts.
   */
  get shouldKillRunningScripts(): Promise<void> {
    return this._killRunningScripts.promise;
  }

  async execute(script: ScriptConfig): Promise<ExecutionResult> {
    const executionKey = scriptReferenceToString(script);
    let promise = this._executions.get(executionKey);
    if (promise === undefined) {
      promise = this._executeAccordingToKind(script)
        .catch((error) => convertExceptionToFailure(error, script))
        .then((result) => {
          if (!result.ok) {
            this.notifyFailure();
          }
          return result;
        });
      this._executions.set(executionKey, promise);
    }
    return promise;
  }

  private _executeAccordingToKind(
    script: ScriptConfig
  ): Promise<ExecutionResult> {
    if (script.command === undefined) {
      return NoCommandScriptExecution.execute(script, this, this._logger);
    }
    if (script.service) {
      return ServiceFingerprinter.fingerprint(script, this, this._logger);
    }
    return StandardScriptExecution.execute(
      script,
      this,
      this._workerPool,
      this._cache,
      this._logger
    );
  }
}
