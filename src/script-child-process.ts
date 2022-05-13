/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import {spawn} from 'child_process';
import {
  augmentProcessEnvSafelyIfOnWindows,
  IS_WINDOWS,
} from './util/windows.js';
import {Deferred} from './util/deferred.js';

import type {Result} from './error.js';
import type {ScriptConfigWithRequiredCommand} from './script.js';
import type {ChildProcessWithoutNullStreams} from 'child_process';
import type {ExitNonZero, ExitSignal, SpawnError, Terminated} from './event.js';

/**
 * The PATH environment variable of this process, minus all of the leading
 * "node_modules/.bin" entries that the incoming "npm run" command already set.
 *
 * We want full control over which "node_modules/.bin" paths are in the PATH of
 * the processes we spawn, so that cross-package dependencies act as though we
 * are running "npm run" with each package as the cwd.
 *
 * We only need to do this once per Wireit process, because process.env never
 * changes.
 */
const PATH_ENV_SUFFIX = (() => {
  const path = process.env.PATH ?? '';
  // Note the PATH delimiter is platform-dependent.
  const entries = path.split(pathlib.delimiter);
  const nodeModulesBinSuffix = pathlib.join('node_modules', '.bin');
  const endOfNodeModuleBins = entries.findIndex(
    (entry) => !entry.endsWith(nodeModulesBinSuffix)
  );
  return entries.slice(endOfNodeModuleBins).join(pathlib.delimiter);
})();

export type ScriptChildProcessState =
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped';

/**
 * A child process spawned during execution of a script.
 */
export class ScriptChildProcess {
  readonly #script: ScriptConfigWithRequiredCommand;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #spawned = new Deferred<Result<void, SpawnError>>();
  readonly #completed = new Deferred<
    Result<void, SpawnError | ExitSignal | ExitNonZero | Terminated>
  >();
  #state: ScriptChildProcessState = 'starting';

  /**
   * Resolves when this child has been spawned or failed to spawn.
   */
  get spawned(): Promise<Result<void, SpawnError>> {
    return this.#spawned.promise;
  }

  /**
   * Resolves when this child process ends.
   */
  get completed(): Promise<
    Result<void, SpawnError | ExitSignal | ExitNonZero | Terminated>
  > {
    return this.#completed.promise;
  }

  get stdout() {
    return this.#child.stdout;
  }

  get stderr() {
    return this.#child.stderr;
  }

  constructor(script: ScriptConfigWithRequiredCommand) {
    this.#script = script;

    // TODO(aomarks) Update npm_ environment variables to reflect the new
    // package.
    this.#child = spawn(script.command.value, {
      cwd: script.packageDir,
      // Conveniently, "shell:true" has the same shell-selection behavior as
      // "npm run", where on macOS and Linux it is "sh", and on Windows it is
      // %COMSPEC% || "cmd.exe".
      //
      // References:
      //   https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
      //   https://nodejs.org/api/child_process.html#default-windows-shell
      //   https://github.com/npm/run-script/blob/a5b03bdfc3a499bf7587d7414d5ea712888bfe93/lib/make-spawn-args.js#L11
      shell: true,
      env: augmentProcessEnvSafelyIfOnWindows({
        PATH: this.#pathEnvironmentVariable,
      }),
      // Set "detached" on Linux and macOS so that we create a new process
      // group, instead of being added to the process group for this Wireit
      // process.
      //
      // We need a new process group so that we can use "kill(-pid)" to kill all
      // of the processes in the process group, instead of just the group leader
      // "sh" process. "sh" does not forward signals to child processes, so a
      // regular "kill(pid)" would not kill the actual process we care about.
      //
      // On Windows this works differently, and we use the "\t" flag to
      // "taskkill" to kill child processes. However, if we do set "detached" on
      // Windows, it causes the child process to open in a new terminal window,
      // which we don't want.
      detached: !IS_WINDOWS,
    });

    this.#child.on('spawn', () => {
      switch (this.#state) {
        case 'starting': {
          this.#spawned.resolve({ok: true, value: undefined});
          this.#state = 'started';
          break;
        }
        case 'stopping': {
          // We received a termination request while we were still starting.
          // Terminate now that we're started.
          this.#actuallyTerminate();
          break;
        }
        case 'started':
        case 'stopped': {
          const error = new Error(
            `Internal error: Expected ScriptChildProcessState ` +
              `to be "started" or "stopping" but was "${this.#state}"`
          );
          this.#spawned.reject(error);
          this.#completed.reject(error);
          break;
        }
        default: {
          const never: never = this.#state;
          const error = new Error(
            `Internal error: unexpected ScriptChildProcessState: ${String(
              never
            )}`
          );
          this.#spawned.reject(error);
          this.#completed.reject(error);
        }
      }
    });

    this.#child.on('error', (error) => {
      const failure: Result<void, SpawnError> = {
        ok: false,
        error: {
          script,
          type: 'failure',
          reason: 'spawn-error',
          message: error.message,
        },
      };
      this.#spawned.resolve(failure);
      this.#completed.resolve(failure);
      this.#state = 'stopped';
    });

    this.#child.on('close', (status, signal) => {
      if (this.#state === 'stopping') {
        this.#completed.resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'terminated',
          },
        });
      } else if (signal !== null) {
        this.#completed.resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'signal',
            signal,
          },
        });
      } else if (status !== 0) {
        this.#completed.resolve({
          ok: false,
          error: {
            script,
            type: 'failure',
            reason: 'exit-non-zero',
            // status should only ever be null if signal was not null, but
            // this isn't reflected in the TypeScript types. Just in case, and
            // to make TypeScript happy, fall back to -1 (which is a
            // conventional exit status used for "exited with signal").
            status: status ?? -1,
          },
        });
      } else {
        this.#completed.resolve({ok: true, value: undefined});
      }
      this.#state = 'stopped';
    });
  }

  /**
   * Mark this child process for termination. On Linux/macOS, sends a `SIGINT`
   * signal. On Windows, invokes `taskkill /pid PID /t /f`.
   *
   * Note this function returns immediately. To find out when the process
   * actually terminates, use the {@link completed} promise.
   */
  terminate(): void {
    switch (this.#state) {
      case 'started': {
        this.#actuallyTerminate();
        return;
      }
      case 'starting': {
        // We're still starting up, and it's not possible to abort. When we get
        // the "spawn" event, we'll notice the "stopping" state and actually
        // terminate then.
        this.#state = 'stopping';
        return;
      }
      case 'stopping':
      case 'stopped': {
        // No-op.
        return;
      }
      default: {
        const never: never = this.#state;
        throw new Error(
          `Internal error: unexpected ScriptChildProcessState: ${String(never)}`
        );
      }
    }
  }

  #actuallyTerminate(): void {
    if (this.#child.pid === undefined) {
      throw new Error(
        `Internal error: Can't terminate child process because it has no pid. ` +
          `Command: ${JSON.stringify(this.#script.command)}.`
      );
    }
    if (IS_WINDOWS) {
      // Windows doesn't have signals. Node ChildProcess.kill() sort of emulates
      // the behavior of SIGKILL (and ignores the signal you pass in), but this
      // doesn't end child processes. We have child processes because the parent
      // process is cmd.exe or PowerShell.
      // https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
      spawn('taskkill', [
        '/pid',
        this.#child.pid.toString(),
        /* End child processes */ '/t',
        /* Forceful */ '/f',
      ]);
    } else {
      // We used "detached" when we spawned, so our child is the leader of a
      // process group. Passing the negative of a pid kills all processes in
      // that group (without the negative, only the leader "sh" process would be
      // killed).
      process.kill(-this.#child.pid, 'SIGINT');
    }
    this.#state = 'stopping';
  }

  /**
   * Generates the PATH environment variable that should be set when this
   * script's command is spawned.
   */
  get #pathEnvironmentVariable(): string {
    // Given package "/foo/bar", walk up the path hierarchy to generate
    // "/foo/bar/node_modules/.bin:/foo/node_modules/.bin:/node_modules/.bin".
    const entries = [];
    let cur = this.#script.packageDir;
    while (true) {
      entries.push(pathlib.join(cur, 'node_modules', '.bin'));
      const parent = pathlib.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
    // Add the inherited PATH variable, minus any "node_modules/.bin" entries
    // that were set by the "npm run" command that spawned Wireit.
    entries.push(PATH_ENV_SUFFIX);
    // Note the PATH delimiter is platform-dependent.
    return entries.join(pathlib.delimiter);
  }
}
