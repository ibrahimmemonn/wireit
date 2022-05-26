/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from 'fs/promises';
import {
  ScriptReference,
  ScriptReferenceString,
  scriptReferenceToString,
  stringToScriptReference,
} from '../script.js';
import {getScriptDataDir} from '../util/script-data-dir.js';

type Chunk = [Buffer | string, 'stdout' | 'stderr'];
type ScriptState = 'running' | 'succeeded' | 'failed';

export class StdioManager {
  #verbose: boolean;
  #lockHeldBy?: ScriptReferenceString;
  #queue = new Set<ScriptReferenceString>();
  #buffers = new Map<ScriptReferenceString, Chunk[]>();
  #state = new Map<ScriptReferenceString, ScriptState>();
  #writeStreams = new Map<ScriptReferenceString, Promise<fs.FileHandle>>();

  constructor(verbose: boolean) {
    this.#verbose = verbose;
  }

  onChunk(
    script: ScriptReferenceString,
    chunk: string | Buffer,
    stream: 'stdout' | 'stderr'
  ) {
    if (this.#lockHeldBy === script) {
      this.#emit(chunk, stream);
    } else {
      const shouldEmit = isMain(script) || this.#verbose;
      if (shouldEmit) {
        if (this.#lockHeldBy === undefined) {
          this.#lockHeldBy = script;
          this.#emit(chunk, stream);
        } else {
          this.#queue.add(script);
        }
      }
    }
    void this.#writeToFile(script, chunk, stream);
  }

  onStateChange(script: ScriptReferenceString, state: ScriptState) {
    const main = isMain(script);
    switch (state) {
      case 'failed': {
        if (this.#lockHeldBy === script) {
          this.#releaseLock();
          this.#closeFile();
        } else {
          this.#queue.add(script);
        }
        return;
      }
      case 'succeeded': {
        if (this.#lockHeldBy === script) {
          this.#releaseLock();
          this.#closeFile();
        } else {
          const shouldEmit = isMain(script) || this.#verbose;
          if (shouldEmit) {
            this.#queue.add(script);
          }
        }
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

  #releaseLock() {}

  async #writeToDisk(
    script: ScriptReferenceString,
    chunk: string | Buffer,
    stream: 'stdout' | 'stderr'
  ) {
    let fileHandlePromise = this.#writeStreams.get(script);
    if (fileHandlePromise === undefined) {
      const path = pathlib.join(
        getScriptDataDir(stringToScriptReference(script)),
        stream === 'stdout' ? 'stdout' : 'stderr'
      );
      fileHandlePromise = fs.open(path, 'ax+');
      this.#writeStreams.set(script, fileHandlePromise);
    }
    const fileHandle = await fileHandlePromise;
    await fileHandle.write(chunk);
  }

  #emit(chunk: string | Buffer, stream: 'stdout' | 'stderr') {
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
      this.#emit(chunk, stream);
    }
    this.#buffers.delete(script);
  }
}

function isMain(_script: ScriptReferenceString) {
  return false;
}

function getState(_script: ScriptReferenceString): ScriptState {
  return 'running';
}
