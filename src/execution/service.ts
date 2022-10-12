/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';
import {ScriptChildProcess} from '../script-child-process.js';

import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {ScriptConfig, StandardScriptConfig} from '../config.js';
import type {Logger} from '../logging/logger.js';
import type {Failure} from '../event.js';
import type {Result} from '../error.js';

export type RequireServiceFunction = () => Promise<
  Result<RequireServiceResult, Failure>
>;

export type RequireServiceResult = {
  unrequire: () => void;
  unexpectedExit: Promise<Failure>;
};

/**
 * Executes a service's dependencies, calculates its fingerprint, and returns a
 * {@link Service} that can be used to start and stop the service if needed.
 *
 * Note that services only run when they are needed by another script or when
 * directly invoked, hence the separation between the fingerprinter and the
 * service itself.
 */
export class ServiceFingerprinter extends BaseExecution<StandardScriptConfig> {
  static fingerprint(
    script: StandardScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new ServiceFingerprinter(script, executor, logger)._fingerprint();
  }

  private async _fingerprint(): Promise<ExecutionResult> {
    const result = await this.executeDependencies();
    if (!result.ok) {
      return result;
    }
    const fingerprint = await Fingerprint.compute(
      this.script,
      result.value.fingerprints
    );
    const service = new Service(
      this.script,
      this.logger,
      fingerprint,
      result.value.services
    );
    return {
      ok: true,
      value: {
        fingerprint,
        services: [() => service.require()],
      },
    };
  }
}

type ServiceState =
  | 'unstarted'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'failed';

function unknownState(state: never) {
  return new Error(`Unknown service state ${String(state)}`);
}

function unexpectedState(state: ServiceState) {
  return new Error(`Unexpected service state ${state}`);
}

class Service {
  private readonly _script: StandardScriptConfig;
  // private readonly _logger: Logger;
  // private readonly _fingerprint: Fingerprint;
  private readonly _dependencyServices: RequireServiceFunction[];
  private readonly _started = new Deferred<Result<void, Failure>>();
  private readonly _unexpectedExit = new Deferred<Failure>();
  private _state: ServiceState = 'unstarted';
  private _child?: ScriptChildProcess;
  private _numRequirers = 0;

  constructor(
    script: StandardScriptConfig,
    _logger: Logger,
    _fingerprint: Fingerprint,
    dependencyServices: RequireServiceFunction[]
  ) {
    this._script = script;
    // this._logger = logger;
    // this._fingerprint = fingerprint;
    this._dependencyServices = dependencyServices;

    if (this._isBeingInvokedDirectly) {
      void this._start();
    }

    console.log(this._numRequirers);
  }

  async require(): Promise<Result<RequireServiceResult, Failure>> {
    this._numRequirers++;
    void this._start();
    const result = await this._started.promise;
    if (!result.ok) {
      this._numRequirers--;
      return result;
    }
    let unrequireCalled = false;
    return {
      ok: true,
      value: {
        unrequire: () => {
          if (!unrequireCalled) {
            unrequireCalled = true;
            this._numRequirers--;
          }
        },
        unexpectedExit: this._unexpectedExit.promise,
      },
    };
  }

  release(): void {
    return undefined;
  }

  private get _isBeingInvokedDirectly(): boolean {
    // TODO(aomarks) Implement
    return false;
  }

  /**
   * Find the scripts that may need this service to start.
   *
   * Accounts for the fact that we need to walk through no-command scripts,
   * because if a script A depends on no-op script B, and B depends on service
   * C, then A depends on service C.
   */
  _countPotentialRequirers(): number {
    if (this._script.reverseDependencies.length === 0) {
      return 0;
    }
    const consumers = new Set<ScriptConfig>();
    const stack: ScriptConfig[] = [this._script];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const current = stack.pop()!;
      for (const {config} of current.reverseDependencies) {
        const hasNoCommand = config.command === undefined;
        if (hasNoCommand) {
          // Walk through
          stack.push(config);
        } else {
          consumers.add(config);
        }
      }
    }
    return consumers.size;
  }

  private async _start() {
    switch (this._state) {
      case 'unstarted': {
        this._state = 'starting';
        const dependencyServiceResults = await Promise.all(
          this._dependencyServices.map((requireService) => requireService())
        );
        const error = dependencyServiceResults.find((result) => !result.ok);
        if (error && !error.ok) {
          this._state = 'failed';
          this._started.resolve(error);
          return;
        }
        this._child = new ScriptChildProcess(this._script);
        const startResult = await this._child.started;
        this._state = startResult.ok ? 'started' : 'failed';
        this._started.resolve(startResult);
        void this._child.completed.then((result) => {
          this._onChildCompleted(result);
        });
        return;
      }
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped':
      case 'failed': {
        return;
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onChildCompleted(_result: Result<void, Failure>) {
    switch (this._state) {
      case 'stopping': {
        this._state = 'stopped';
        return;
      }
      case 'started': {
        // A service should never exit by itself, only when we are stopping it,
        // so this indicates a failure.
        this._state = 'failed';
        // TODO(aomarks) How do other scripts find out?
        return;
      }
      case 'unstarted':
      case 'starting':
      case 'stopped':
      case 'failed': {
        throw unexpectedState(this._state);
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }
}
