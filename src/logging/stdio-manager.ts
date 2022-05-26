/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
} from '../script.js';

type Chunk = [Buffer | string, 'stdout' | 'stderr'];

export class StdioManager {
  #verbose: boolean;
  #buffers = new Map<ScriptReferenceString, Chunk[]>();

  constructor(verbose: boolean) {
    this.#verbose = verbose;
  }

  onChunk(
    script: ScriptReference,
    chunk: string | Buffer,
    stream: 'stdout' | 'stderr'
  ) {
    if (this.#verbose) {
      this.#write(chunk, stream);
      return;
    }

    const main = isMain(script);
    const state = getState(script);
    const key = scriptReferenceToString(script);
    switch (state) {
      case 'failed': {
        this.#write(chunk, stream);
        return;
      }
      case 'succeeded': {
        if (main) {
          this.#write(chunk, stream);
        }
        return;
      }
      case 'running': {
        if (main) {
          this.#write(chunk, stream);
        } else {
          this.#buffer(key, chunk, stream);
        }
        return;
      }
      default: {
        const never = state;
        throw new Error(`Unknown stdio script state: ${String(never)}`);
      }
    }
  }

  onStateChange(script: ScriptReference, state: ScriptState) {
    const main = isMain(script);
    const key = scriptReferenceToString(script);
    switch (state) {
      case 'failed': {
        if (!main) {
          this.#flush(key);
        }
        return;
      }
      case 'succeeded': {
        return;
      }
      case 'running': {
        return;
      }
      default: {
        const never = state;
        throw new Error(`Unknown stdio script state: ${String(never)}`);
      }
    }
  }

  #write(chunk: string | Buffer, stream: 'stdout' | 'stderr') {
    if (stream === 'stdout') {
      process.stdout.write(chunk);
    } else {
      process.stderr.write(chunk);
    }
  }

  #buffer(
    script: ScriptReferenceString,
    chunk: string | Buffer,
    stream: 'stdout' | 'stderr'
  ) {
    let chunks = this.#buffers.get(script);
    if (chunks === undefined) {
      chunks = [];
      this.#buffers.set(script, chunks);
    }
    chunks.push([chunk, stream]);
  }

  #flush(script: ScriptReferenceString) {
    const chunks = this.#buffers.get(script);
    if (chunks === undefined) {
      return;
    }
    for (const [chunk, stream] of chunks) {
      this.#write(chunk, stream);
    }
    this.#buffers.delete(script);
  }
}

function isMain(_script: ScriptReference) {
  return false;
}

type ScriptState = 'running' | 'succeeded' | 'failed';

function getState(_script: ScriptReference): ScriptState {
  return 'running';
}
