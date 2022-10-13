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
import type {Failure, ServiceExitedUnexpectedly} from '../event.js';
import type {Result} from '../error.js';

export type RequireServiceFunction = () => Promise<
  Result<RequireServiceResult, Failure>
>;

export type RequireServiceResult = {
  unrequire: () => void;
  unexpectedExit: Promise<ServiceExitedUnexpectedly>;
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
      this.executor,
      this.logger,
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

/**
 * ```
 *                    ┌───────────┐
 *     ╭── ABORT ─────┤ unstarted │
 *     │              └────┬──────┘
 *     │                   │
 *     │              FIRST_REQUIRE
 *     │                   │
 *     │              ┌────▼─────┐
 *     │    ╭─ ABORT ─┤ starting ├── DEPENDENCY_FAILED ─►─╮
 *     │    │         └────┬─────┘    or START_ERROR      │
 *     │    │              │                              │
 *     │    │           STARTED                           ▼
 *     │    │              │                              │
 *     │    │         ┌────▼────┐                         │
 *     ▼    ▼         │ started ├── UNEXPECTED_EXIT ───►──┤
 *     │    │         └────┬────┘                         │
 *     │    │              │                              │
 *     │    │        LAST_UNREQUIRE                       │
 *     │    │           or ABORT                          │
 *     │    │              │                              │
 *     │    │         ┌────▼─────┐                        ▼
 *     │    ╰─────────► stopping │                        │
 *     │              └────┬─────┘                        │
 *     │                   │                              │
 *     │              EXPECTED_EXIT                       │
 *     │                   │                              │
 *     │              ┌────▼────┐                    ┌────▼───┐
 *     ╰──────────────► stopped │                    │ failed │
 *                    └─────────┘                    └────────┘
 * ```
 */
class Service {
  private readonly _script: StandardScriptConfig;
  private readonly _executor: Executor;
  private readonly _logger: Logger;
  private readonly _dependencyServices: RequireServiceFunction[];
  private readonly _started = new Deferred<Result<void, Failure>>();
  private readonly _unexpectedExit = new Deferred<ServiceExitedUnexpectedly>();
  private _state: ServiceState = 'unstarted';
  private _child?: ScriptChildProcess;
  private _numRequirers = 0;

  constructor(
    script: StandardScriptConfig,
    executor: Executor,
    logger: Logger,
    dependencyServices: RequireServiceFunction[]
  ) {
    this._script = script;
    this._executor = executor;
    this._logger = logger;
    this._dependencyServices = dependencyServices;

    console.log(this._numRequirers);
  }

  async require(): Promise<Result<RequireServiceResult, Failure>> {
    this._numRequirers++;
    void this._onStart();
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
          stack.push(config);
        } else {
          consumers.add(config);
        }
      }
    }
    return consumers.size;
  }

  private async _onStart() {
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
        this._child.stdout.on('data', (data: string | Buffer) => {
          this._logger.log({
            script: this._script,
            type: 'output',
            stream: 'stdout',
            data,
          });
        });
        this._child.stderr.on('data', (data: string | Buffer) => {
          this._logger.log({
            script: this._script,
            type: 'output',
            stream: 'stderr',
            data,
          });
        });
        const startResult = await this._child.started;
        if (!startResult.ok) {
          this._state = 'failed';
          this._executor.notifyFailure();
          this._started.resolve(startResult);
          return;
        }
        this._state = 'started';
        this._started.resolve(startResult);
        void this._child.completed.then(() => {
          this._onChildCompleted();
        });
        this._logger.log({
          script: this._script,
          type: 'info',
          detail: 'service-started',
        });
        return;
      }
      case 'starting':
      case 'started':
      case 'stopping':
      case 'stopped':
      case 'failed': {
        // TODO(aomarks) These no-ops are not in the diagram.
        return;
      }
      default: {
        throw unknownState(this._state);
      }
    }
  }

  private _onChildCompleted() {
    switch (this._state) {
      case 'stopping': {
        // TODO(aomarks) Does the exit code matter? Non-zero could mean that
        // something actually went wrong that would affect the build. OTOH some
        // server-type processes return a non-zero exit code when they are
        // terminated e.g. "tsc --watch" returns 130. 130 is apparently a
        // conventional code for "terminated by the owner" (actually 128 + the
        // signal)
        this._state = 'stopped';
        this._logger.log({
          script: this._script,
          type: 'info',
          detail: 'service-stopped',
        });
        return;
      }
      case 'started': {
        this._state = 'failed';
        this._executor.notifyFailure();
        const failure = {
          script: this._script,
          type: 'failure',
          reason: 'service-exited-unexpectedly',
        } as const;
        this._unexpectedExit.resolve(failure);
        this._logger.log(failure);
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
