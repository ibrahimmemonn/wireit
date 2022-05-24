/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'crypto';
import {createReadStream} from 'fs';
import {resolve} from 'path';
import {glob} from './util/glob.js';
import {scriptReferenceToString} from './script.js';

import type {
  ScriptConfig,
  ScriptReference,
  ScriptReferenceString,
} from './script.js';
import type {ExecutionResultData} from './execution/base.js';

/**
 * All meaningful inputs of a script. Used for determining if a script is fresh,
 * and as the key for storing cached output.
 */
export interface FingerprintData {
  /**
   * Brand to make it slightly harder to create one of these interfaces, because
   * that should only ever be done via {@link Fingerprint.compute}.
   */
  __FingerprintDataBrand__: never;

  /**
   * Whether the output for this script can be fresh or cached.
   *
   * True only if the "files" array was defined for this script, and for all of
   * this script's transitive dependencies.
   */
  cacheable: boolean;

  /** E.g. linux, win32 */
  platform: NodeJS.Platform;

  /** E.g. x64 */
  arch: string;

  /** E.g. 16.7.0 */
  nodeVersion: string;

  /**
   * The shell command from the Wireit config.
   */
  command: string | undefined;

  /**
   * The "clean" setting from the Wireit config.
   *
   * This is included in the fingerprint because switching from "false" to "true"
   * could produce different output, so a re-run should be triggered even if
   * nothing else changed.
   */
  clean: boolean | 'if-file-deleted';

  // Must be sorted.
  files: {[packageDirRelativeFilename: string]: Sha256HexDigest};

  /**
   * The "output" glob patterns from the Wireit config.
   *
   * This is included in the fingerprint because changing the output patterns
   * could produce different output when "clean" is true, and because it affects
   * which files get included in a cache entry.
   *
   * Note the undefined vs empty-array distinction is not meaningful here,
   * because both cases cause no files to be deleted, and the undefined case is
   * never cached anyway.
   */
  output: string[];

  // Must be sorted.
  dependencies: {[dependency: ScriptReferenceString]: FingerprintData};
}

/**
 * String serialization of a {@link FingerprintData}.
 */
export type FingerprintString = string & {
  __FingerprintStringBrand__: never;
};

/**
 * SHA256 hash hexadecimal digest of a file's content.
 */
export type Sha256HexDigest = string & {
  __Sha256HexDigestBrand__: never;
};

/**
 * The fingerprint of a script. Converts lazily between string and data object
 * forms.
 */
export class Fingerprint {
  static fromString(string: FingerprintString): Fingerprint {
    const fingerprint = new Fingerprint();
    fingerprint.#str = string;
    return fingerprint;
  }

  /**
   * Generate the fingerprint data object for a script based on its current
   * configuration, input files, and the fingerprints of its dependencies.
   */
  static async compute(
    script: ScriptConfig,
    dependencyFingerprints: Array<[ScriptReference, ExecutionResultData]>
  ): Promise<Fingerprint> {
    let allDependenciesAreCacheable = true;
    const filteredDependencyFingerprints: Array<
      [ScriptReferenceString, FingerprintData]
    > = [];
    for (const [dep, {fingerprint: depFingerprint}] of dependencyFingerprints) {
      if (!depFingerprint.data.cacheable) {
        allDependenciesAreCacheable = false;
      }
      filteredDependencyFingerprints.push([
        scriptReferenceToString(dep),
        depFingerprint.data,
      ]);
    }

    let fileHashes: Array<[string, Sha256HexDigest]>;
    if (script.files?.values.length) {
      const files = await glob(script.files.values, {
        cwd: script.packageDir,
        absolute: false,
        followSymlinks: true,
        // TODO(aomarks) This means that empty directories are not reflected in
        // the fingerprint, however an empty directory could modify the behavior
        // of a script. We should probably include empty directories; we'll just
        // need special handling when we compute the fingerprint, because there
        // is no hash we can compute.
        includeDirectories: false,
        // We must expand directories here, because we need the complete
        // explicit list of files to hash.
        expandDirectories: true,
        throwIfOutsideCwd: false,
      });
      // TODO(aomarks) Instead of reading and hashing every input file on every
      // build, use inode/mtime/ctime/size metadata (which is much faster to
      // read) as a heuristic to detect files that have likely changed, and
      // otherwise re-use cached hashes that we store in e.g.
      // ".wireit/<script>/hashes".
      fileHashes = await Promise.all(
        files.map(async (file): Promise<[string, Sha256HexDigest]> => {
          const absolutePath = resolve(script.packageDir, file.path);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(absolutePath)) {
            hash.update(chunk as Buffer);
          }
          return [file.path, hash.digest('hex') as Sha256HexDigest];
        })
      );
    } else {
      fileHashes = [];
    }

    const cacheable =
      // If command is undefined, then we simply propagate the fingerprints of
      // our dependencies, and don't have any effect ourselves on cacheability.
      script.command === undefined ||
      // Otherwise, If files are undefined, then it's not safe to be cached,
      // because we don't know what the inputs are, so we can't know if the
      // output of this script could change.
      (script.files !== undefined &&
        // Similarly, if any of our dependencies are uncacheable, then we're
        // uncacheable too, because that dependency could also have an effect on
        // our output.
        allDependenciesAreCacheable);

    const fingerprint = new Fingerprint();

    // Note: The order of all fields is important so that we can do fast string
    // comparison.
    fingerprint.#data = {
      cacheable,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      command: script.command?.value,
      clean: script.clean,
      files: Object.fromEntries(
        fileHashes.sort(([aFile], [bFile]) => aFile.localeCompare(bFile))
      ),
      output: script.output?.values ?? [],
      dependencies: Object.fromEntries(
        filteredDependencyFingerprints.sort(([aRef], [bRef]) =>
          aRef.localeCompare(bRef)
        )
      ),
    } as FingerprintData;
    return fingerprint;
  }

  #str?: FingerprintString;
  #data?: FingerprintData;

  get string(): FingerprintString {
    if (this.#str === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#str = JSON.stringify(this.#data!) as FingerprintString;
    }
    return this.#str;
  }

  get data(): FingerprintData {
    if (this.#data === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.#data = JSON.parse(this.#str!) as FingerprintData;
    }
    return this.#data;
  }

  equal(other: Fingerprint): boolean {
    return this.string === other.string;
  }
}
