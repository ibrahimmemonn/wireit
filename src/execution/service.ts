/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExecution} from './base.js';
import {Fingerprint} from '../fingerprint.js';

import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {ServiceScriptConfig} from '../script.js';
import type {Logger} from '../logging/logger.js';

/**
 * Execution for a {@link ServiceScriptConfig}.
 */
export class ServiceExecution extends BaseExecution<ServiceScriptConfig> {
  static execute(
    script: ServiceScriptConfig,
    executor: Executor,
    logger: Logger
  ): Promise<ExecutionResult> {
    return new ServiceExecution(script, executor, logger).#execute();
  }

  async #execute(): Promise<ExecutionResult> {
    const dependencyResults = await this.executeDependencies();
    if (!dependencyResults.ok) {
      return dependencyResults;
    }
    const fingerprint = await Fingerprint.compute(
      this.script,
      dependencyResults.value
    );
    return {ok: true, value: {fingerprint, services: [this]}};
  }
}
