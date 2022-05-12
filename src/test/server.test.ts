/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {getScriptDataDir} from '../util/script-data-dir.js';

const test = suite<{rig: WireitTestRig}>();

test.before.each(async (ctx) => {
  try {
    ctx.rig = new WireitTestRig();
    await ctx.rig.setup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu before error', error);
    process.exit(1);
  }
});

test.after.each(async (ctx) => {
  try {
    await ctx.rig.cleanup();
  } catch (error) {
    // Uvu has a bug where it silently ignores failures in before and after,
    // see https://github.com/lukeed/uvu/issues/191.
    console.error('uvu after error', error);
    process.exit(1);
  }
});

test(
  'server is never skipped or restored from cache',
  timeout(async ({rig}) => {
    const server = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          server: 'wireit',
        },
        wireit: {
          server: {
            command: server.command,
            server: true,
            // Set files and output so that we can be skipped and cached.
            files: [],
            output: [],
          },
        },
      },
    });

    // Everything runs the first time.
    {
      const wireit = rig.exec('npm run server');
      (await server.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(server.numInvocations, 1);
    }

    // A non-server would now be skipped, but a server is never skipped.
    {
      const wireit = rig.exec('npm run server');
      (await server.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(server.numInvocations, 2);
    }

    // Delete the script's state but not its cache. This would cause a cache hit
    // for a non-server, but a server is never restored from cache.
    {
      await rig.delete(
        `${getScriptDataDir({packageDir: rig.temp, name: 'server'})}/state`
      );
      const wireit = rig.exec('npm run server');
      (await server.nextInvocation()).exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(server.numInvocations, 3);
    }
  })
);

test(
  'dependent on server does not wait for it to exit',
  timeout(async ({rig}) => {
    const server = await rig.newCommand();
    const dependent = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          server: 'wireit',
          dependent: 'wireit',
        },
        wireit: {
          server: {
            command: server.command,
            server: true,
          },
          dependent: {
            command: dependent.command,
            dependencies: ['server'],
          },
        },
      },
    });

    const wireit = rig.exec('npm run dependent');
    const serverInv = await server.nextInvocation();
    const dependentInv = await dependent.nextInvocation();
    dependentInv.exit(0);
    serverInv.exit(0);
    assert.equal((await wireit.exit).code, 0);
  })
);

test.run();
