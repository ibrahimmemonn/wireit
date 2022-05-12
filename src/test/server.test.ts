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

test(
  'server is kept alive until all direct dependents finish',
  timeout(async ({rig}) => {
    //   indirect
    //      |
    //      v
    //  keepalive1
    //     |  \
    //     |   v
    //     | keepalive2
    //     |  /
    //     v v
    //   server
    const server = await rig.newCommand();
    const indirect = await rig.newCommand();
    const keepalive1 = await rig.newCommand();
    const keepalive2 = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          server: 'wireit',
          indirect: 'wireit',
          keepalive1: 'wireit',
          keepalive2: 'wireit',
        },
        wireit: {
          server: {
            command: server.command,
            server: true,
          },
          indirect: {
            command: indirect.command,
            dependencies: ['keepalive1'],
          },
          keepalive1: {
            command: keepalive1.command,
            dependencies: ['server', 'keepalive2'],
          },
          keepalive2: {
            command: keepalive2.command,
            dependencies: ['server'],
          },
        },
      },
    });
    const wireit = rig.exec('npm run indirect');

    // server starts
    const serverInv = await server.nextInvocation();

    // keepalive2 starts and exits
    const keepalive2Inv = await keepalive2.nextInvocation();
    keepalive2Inv.exit(0);

    // keepalive1 starts
    const keepalive1Inv = await keepalive1.nextInvocation();

    // server keeps running
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(serverInv.isRunning);

    // keepalive1 exits
    keepalive1Inv.exit(0);

    // server should be terminated by wireit now that there are no remaining
    // direct dependencies. indirect still hasn't finished, but it's an indirect
    // dependent, which doesn't count.
    await serverInv.closed;

    // indirect starts and exits
    const indirectInv = await indirect.nextInvocation();
    indirectInv.exit(0);

    // all done
    assert.equal((await wireit.exit).code, 0);
    assert.equal(indirect.numInvocations, 1);
    assert.equal(keepalive1.numInvocations, 1);
    assert.equal(keepalive2.numInvocations, 1);
    assert.equal(server.numInvocations, 1);
  })
);

test(
  'server is kept alive indefinitely if entrypoint',
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
          },
        },
      },
    });
    const wireit = rig.exec('npm run server');
    const serverInv = await server.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(serverInv.isRunning);
    wireit.terminate();
    await serverInv.closed;
    await wireit.exit;
    assert.equal(server.numInvocations, 1);
  })
);

test(
  // TODO(aomarks) Description is wrong
  'server is kept alive indefinitely if closest command to entrypoint',
  timeout(async ({rig}) => {
    // nocommand
    //     |
    //     v
    //  server
    const server = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          nocommand: 'wireit',
          server: 'wireit',
        },
        wireit: {
          nocommand: {
            dependencies: ['server'],
          },
          server: {
            command: server.command,
            server: true,
          },
        },
      },
    });
    const wireit = rig.exec('npm run nocommand');
    const serverInv = await server.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(serverInv.isRunning);
    wireit.terminate();
    await serverInv.closed;
    await wireit.exit;
    assert.equal(server.numInvocations, 1);
  })
);

test.run();
