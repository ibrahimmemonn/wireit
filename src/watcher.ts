/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import chokidar from 'chokidar';
import * as pathlib from 'path';
import {Analyzer} from './analyzer.js';
import {Executor} from './executor.js';
import {Deferred} from './util/deferred.js';
import {scriptReferenceToString} from './script.js';
import {WorkerPool} from './util/worker-pool.js';

import type {Logger} from './logging/logger.js';
import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';
import type {Cache} from './caching/cache.js';
import type {FailureMode} from './executor.js';

/**
 * Watches a script for changes in its input files, and in the input files of
 * its transitive dependencies, and executes all affected scripts when they
 * change.
 *
 * Also watches all related package.json files and reloads script configuration
 * when they change.
 *
 * State diagram:
 *
 *              ┌──────────────────────────────────┐
 *              |  ┌──────────────┐                |
 *              ▼  ▼              |                |
 *           ┌───────┐      ┌───────────┐      ┌───────┐
 * START ───►| stale | ───► | executing | ───► | fresh |
 *           └───────┘      └───────────┘      └───────┘
 *               │                │                │
 *               |                ▼                |
 *               |           ┌─────────┐           |
 *               └─────────► | aborted | ◄─────────┘
 *                           └─────────┘
 */
export class Watcher {
  /**
   * Execute the script, and continue executing it every time a file related to
   * the configured script changes.
   *
   * @returns When the abort promise resolves.
   * @throws If an unexpected error occurs during analysis or execution.
   */
  static watch(
    script: ScriptReference,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>
  ): Promise<void> {
    return new Watcher(
      script,
      logger,
      workerPool,
      cache,
      failureMode,
      abort
    ).#watch();
  }

  readonly #script: ScriptReference;
  readonly #logger: Logger;
  readonly #workerPool: WorkerPool;
  readonly #watchers: Array<chokidar.FSWatcher> = [];
  readonly #cache?: Cache;
  readonly #failureMode: FailureMode;
  readonly #abort: Deferred<void>;
  #currentExecutor?: Executor;

  /** Whether an executor is currently running. */
  #executing = false;

  /** Whether a file has changed since the last time we executed. */
  #stale = true;

  /** Whether the watcher has been aborted. */
  get #aborted() {
    return this.#abort.settled;
  }

  /** Notification that some state has changed. */
  #update = new Deferred<void>();

  private constructor(
    script: ScriptReference,
    logger: Logger,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    failureMode: FailureMode,
    abort: Deferred<void>
  ) {
    this.#script = script;
    this.#logger = logger;
    this.#workerPool = workerPool;
    this.#abort = abort;
    this.#failureMode = failureMode;
    this.#cache = cache;

    if (!this.#aborted) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      abort.promise.then(() => {
        // TODO(aomarks) Aborting should also cause the analyzer and executors to
        // stop if they are running. Currently we only stop after the current
        // build entirely finishes.
        this.#update.resolve();
      });
    }
  }

  /**
   * The main watch loop.
   */
  async #watch(): Promise<void> {
    try {
      while (!this.#aborted) {
        if (this.#stale && !this.#executing) {
          await this.#analyzeAndExecute();
        }
        await this.#update.promise;
        this.#update = new Deferred();
      }
    } finally {
      // It's important to close all chokidar watchers, because they will
      // prevent the Node program from ever exiting as long as they are active.
      await this.#clearWatchers();
    }
  }

  /**
   * Perform an analysis and execution.
   */
  async #analyzeAndExecute(): Promise<void> {
    this.#logger.log({
      script: this.#script,
      type: 'info',
      detail: 'watch-run-start',
    });

    // Reset _stale before execution, not after, because a file could change
    // during execution, and we must not clobber that.
    this.#stale = false;
    this.#executing = true;

    // TODO(aomarks) We only need to reset watchers and re-analyze if a
    // package.json file changed.
    const analyzer = new Analyzer();

    // TODO(aomarks) Add support for recovering from analysis errors. We'll need
    // to track the package.json files that we encountered, and watch them.
    const analysisResult = await analyzer.analyze(this.#script);
    await this.#clearWatchers();
    if (!analysisResult.ok) {
      for (const failure of analysisResult.error) {
        this.#logger.log(failure);
      }
      process.exit(1);
    } else {
      const analysis = analysisResult.value;
      for (const {patterns, cwd} of this.#getWatchPathGroups(analysis)) {
        this.#watchPatterns(patterns, cwd);
      }
      this.#currentExecutor = new Executor(
        this.#logger,
        this.#workerPool,
        this.#cache,
        this.#failureMode,
        this.#abort
      );
      const result = await this.#currentExecutor.executeTopLevel(analysis);
      if (!result.ok) {
        for (const error of result.error) {
          this.#logger.log(error);
        }
      }
    }

    this.#executing = false;
    this.#update.resolve();
    this.#logger.log({
      script: this.#script,
      type: 'info',
      detail: 'watch-run-end',
    });
  }

  /**
   * Start watching some glob patterns.
   */
  #watchPatterns(patterns: string[], cwd: string): void {
    const watcher = chokidar.watch(patterns, {
      cwd,
      // Ignore the initial "add" events emitted when chokidar first discovers
      // each file. We already do an initial run, so these events are just noise
      // that may trigger an unnecessary second run.
      // https://github.com/paulmillr/chokidar#path-filtering
      ignoreInitial: true,
    });
    this.#watchers.push(watcher);
    watcher.on('add', this.#fileAddedOrChanged);
    watcher.on('unlink', this.#fileAddedOrChanged);
    watcher.on('change', this.#fileAddedOrChanged);
  }

  /**
   * One of the paths we are watching has been created or modified.
   */
  readonly #fileAddedOrChanged = (): void => {
    console.log('xxxxxxxxxxxxxxx FILE CHANGED');
    // TODO(aomarks) Cache package JSONS, globs, and hashes.
    this.#stale = true;
    this.#update.resolve();
    this.#currentExecutor?.killTopLevelServices();
  };

  /**
   * Shut down all active file watchers and clear the list.
   */
  async #clearWatchers(): Promise<void> {
    const watchers = this.#watchers.splice(0, this.#watchers.length);
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  /**
   * Walk through a script config and return a list of absolute filesystem paths
   * that we should watch for changes.
   */
  #getWatchPathGroups(
    script: ScriptConfig
  ): Array<{patterns: string[]; cwd: string}> {
    const packageJsons = new Set<string>();
    const groups: Array<{patterns: string[]; cwd: string}> = [];
    const visited = new Set<ScriptReferenceString>();

    const visit = (script: ScriptConfig) => {
      const key = scriptReferenceToString(script);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      packageJsons.add(pathlib.join(script.packageDir, 'package.json'));
      if (script.files !== undefined) {
        // TODO(aomarks) We could optimize to create fewer watchers, but we have
        // to be careful to deal with "!"-prefixed negation entries, because
        // those negations only apply to the previous entries **in that specific
        // "files" array**. A simple solution could be that if a "files" array
        // has any "!"-prefixed entry, then it gets its own watcher, otherwise
        // we can group watchers by packageDir.
        groups.push({patterns: script.files.values, cwd: script.packageDir});
      }
      for (const dependency of script.dependencies) {
        visit(dependency.config);
      }
    };

    visit(script);
    groups.push({
      // The package.json group is already resolved to absolute paths, so cwd is
      // arbitrary.
      cwd: process.cwd(),
      patterns: [...packageJsons],
    });
    return groups;
  }
}
