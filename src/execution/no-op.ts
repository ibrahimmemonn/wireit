/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {Deferred} from '../util/deferred.js';

import type {ExecutionResult} from './base.js';
import type {NoOpScriptConfig} from '../script.js';

/**
 * Execution for a {@link NoOpScriptConfig}.
 */
export class NoOpExecution extends BaseExecution<NoOpScriptConfig> {
  readonly #done = new Deferred<void>();
  get done() {
    return this.#done.promise;
  }

  async execute(): Promise<ExecutionResult> {
    const dependencyResults = await this.executeDependencies();
    if (!dependencyResults.ok) {
      return dependencyResults;
    }
    const fingerprint = await Fingerprint.compute(
      this.script,
      dependencyResults.value
    );

    // Forward up all services from dependencies.
    const services = [];
    for (const [, result] of dependencyResults.value) {
      for (const service of result.services) {
        services.push(service);
      }
    }

    this.logger.log({
      script: this.script,
      type: 'success',
      reason: 'no-command',
    });

    this.#done.resolve();

    return {ok: true, value: {fingerprint, services}};
  }
}
