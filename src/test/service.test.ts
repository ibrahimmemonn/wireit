/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';

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
  'top-level service runs until wireit killed',
  timeout(async ({rig}) => {
    const service = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          service: 'wireit',
        },
        wireit: {
          service: {
            service: true,
            command: service.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run service');
    const serviceInv = await service.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(serviceInv.running);
    wireit.kill();
    await serviceInv.closed;
    await wireit.exit;
    assert.equal(service.numInvocations, 1);
  })
);

test(
  'service runs until consumer is done',
  timeout(async ({rig}) => {
    const service = await rig.newCommand();
    const consumer = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          service: 'wireit',
          consumer: 'wireit',
        },
        wireit: {
          service: {
            service: true,
            command: service.command,
          },
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
          },
        },
      },
    });

    const wireit = rig.exec('npm run consumer');
    const serviceInv = await service.nextInvocation();
    const consumerInv = await consumer.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(serviceInv.running);
    assert.ok(consumerInv.running);
    consumerInv.exit(0);
    await serviceInv.closed;
    assert.equal((await wireit.exit).code, 0);
    assert.equal(service.numInvocations, 1);
    assert.equal(consumer.numInvocations, 1);
  })
);

test(
  'service is skipped if no consumer needs it',
  timeout(async ({rig}) => {
    const service = await rig.newCommand();
    const consumer = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          service: 'wireit',
          consumer: 'wireit',
        },
        wireit: {
          service: {
            service: true,
            command: service.command,
            files: ['input/service'],
          },
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
            files: ['input/consumer'],
          },
        },
      },
    });

    // First run is stale, so the service is required.
    {
      const wireit = rig.exec('npm run consumer');
      await service.nextInvocation();
      const consumerInv = await consumer.nextInvocation();
      consumerInv.exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(service.numInvocations, 1);
      assert.equal(consumer.numInvocations, 1);
    }

    // Second run is fresh, so the service is not required.
    {
      const wireit = rig.exec('npm run consumer');
      assert.equal((await wireit.exit).code, 0);
      assert.equal(service.numInvocations, 1);
      assert.equal(consumer.numInvocations, 1);
    }

    // Changing the consumer's input file triggers the consumer because it is
    // stale, and also starts the service. Even though the service previously
    // succeeded with the same fingerprint, it can never be skipped if something
    // needs to run which depends on it.
    {
      await rig.write('input/consumer', 'v1');
      const wireit = rig.exec('npm run consumer');
      await service.nextInvocation();
      const consumerInv = await consumer.nextInvocation();
      consumerInv.exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(service.numInvocations, 2);
      assert.equal(consumer.numInvocations, 2);
    }

    // Changing the service's input file triggers both, because the service has
    // changed, which is included in the consumer's fingerprint, so the consumer
    // is stale, which triggers the service.
    {
      await rig.write('input/service', 'v1');
      const wireit = rig.exec('npm run consumer');
      await service.nextInvocation();
      const consumerInv = await consumer.nextInvocation();
      consumerInv.exit(0);
      assert.equal((await wireit.exit).code, 0);
      assert.equal(service.numInvocations, 3);
      assert.equal(consumer.numInvocations, 3);
    }
  })
);

test(
  'service stays running until all consumers are done',
  timeout(async ({rig}) => {
    //  main
    //   / \          A and B both depend on the service. C is going to
    //  A   B --> C   block B from running until A is done. The service
    //  |   |         should stay running until A and B are both done.
    //  v   v
    // service
    const service = await rig.newCommand();
    const a = await rig.newCommand();
    const b = await rig.newCommand();
    const c = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          service: 'wireit',
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          main: {
            dependencies: ['a', 'b'],
          },
          service: {
            service: true,
            command: service.command,
          },
          a: {
            command: a.command,
            dependencies: ['service'],
          },
          b: {
            command: b.command,
            dependencies: ['service', 'c'],
          },
          c: {
            command: c.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run main');
    const serviceInv = await service.nextInvocation();
    const aInv = await a.nextInvocation();
    const cInv = await c.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(serviceInv.running);

    aInv.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(serviceInv.running);

    cInv.exit(0);
    const bInv = await b.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(serviceInv.running);

    bInv.exit(0);
    await serviceInv.closed;
    assert.equal((await wireit.exit).code, 0);
    assert.equal(service.numInvocations, 1);
    assert.equal(a.numInvocations, 1);
    assert.equal(b.numInvocations, 1);
    assert.equal(c.numInvocations, 1);
  })
);

test(
  'consumer plus top-level',
  timeout(async ({rig}) => {
    const service = await rig.newCommand();
    const consumer = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          main: 'wireit',
          service: 'wireit',
          consumer: 'wireit',
        },
        wireit: {
          main: {
            dependencies: ['service', 'consumer'],
          },
          service: {
            service: true,
            command: service.command,
            files: ['input/service'],
          },
          consumer: {
            command: consumer.command,
            dependencies: ['service'],
            files: ['input/consumer'],
          },
        },
      },
    });

    const wireit = rig.exec('npm run main');
    const serviceInv = await service.nextInvocation();
    const consumerInv = await consumer.nextInvocation();

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(serviceInv.running);

    consumerInv.exit(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(serviceInv.running);

    wireit.kill();
    await serviceInv.closed;
    await wireit.exit;

    assert.equal(service.numInvocations, 1);
    assert.equal(consumer.numInvocations, 1);

    // The problem here is that execute() doesn't return until all the one-shots
    // are done, so cli doesn't call start() on the service until that's
    // happened, at which point the service has already started shutting down.
  })
);

test(
  'service depends on another service',
  timeout(async ({rig}) => {
    const service1 = await rig.newCommand();
    const service2 = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          service1: 'wireit',
          service2: 'wireit',
        },
        wireit: {
          service1: {
            service: true,
            command: service1.command,
            dependencies: ['service2'],
          },
          service2: {
            service: true,
            command: service2.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run service1');
    const service2Inv = await service2.nextInvocation();
    const service1Inv = await service1.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(service1Inv.running);
    assert.ok(service2Inv.running);
    wireit.kill();
    await service2Inv.closed;
    await service1Inv.closed;
    await wireit.exit;
    assert.equal(service1.numInvocations, 1);
    assert.equal(service2.numInvocations, 1);
  })
);

test.skip(
  'service stops when service dependency fails',
  timeout(async ({rig}) => {
    const service1 = await rig.newCommand();
    const service2 = await rig.newCommand();
    await rig.write({
      'package.json': {
        scripts: {
          service1: 'wireit',
          service2: 'wireit',
        },
        wireit: {
          service1: {
            service: true,
            command: service1.command,
            dependencies: ['service2'],
          },
          service2: {
            service: true,
            command: service2.command,
          },
        },
      },
    });

    const wireit = rig.exec('npm run service1');
    const service2Inv = await service2.nextInvocation();
    const service1Inv = await service1.nextInvocation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(service1Inv.running);
    assert.ok(service2Inv.running);
    service2Inv.exit(1);
    await service2Inv.closed;
    await service1Inv.closed;
    assert.equal((await wireit.exit).code, 1);
    assert.equal(service1.numInvocations, 1);
    assert.equal(service2.numInvocations, 1);
  })
);

// TODO(aomarks) Service failures
// TODO(aomarks) Watch mode
// TODO(aomarks) Locking

test.run();
