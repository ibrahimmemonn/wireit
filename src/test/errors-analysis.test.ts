/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import * as pathlib from 'path';
import {timeout} from './util/uvu-timeout.js';
import {WireitTestRig} from './util/test-rig.js';
import {NODE_MAJOR_VERSION} from './util/node-version.js';

const test = suite<{rig: WireitTestRig}>();

// The npm version that ships with with Node 14 produces a bunch of additional
// logs when running a script, so we need to use the less strict assert.match.
// assert.equal gives a better error message.
const assertScriptOutputEquals = (
  actual: string,
  expected: string,
  message?: string
) => {
  const assertOutputEqualish =
    NODE_MAJOR_VERSION < 16 ? assert.match : assert.equal;

  assertOutputEqualish(actual.trim(), expected.trim(), message);
};

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
  'wireit section is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: [],
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: wireit is not an object\n`
    );
  })
);

test(
  'wireit config is not an object',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: [],
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: wireit[a] is not an object`
    );
  })
);

test(
  'dependencies is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: dependencies is not an array`
    );
  })
);

test(
  'dependency is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [[]],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: dependencies[0] is not a string`
    );
  })
);

test(
  'dependency is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: [' '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: dependencies[0] is empty or blank`
    );
  })
);

test(
  'command is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: [],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: command is not a string`
    );
  })
);

test(
  'command is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: '',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: command is empty or blank`
    );
  })
);

test(
  'files is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: files is not an array`
    );
  })
);

test(
  'file item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: files[0] is not a string`
    );
  })
);

test(
  'file item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            files: [''],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: files[0] is empty or blank`
    );
  })
);

test(
  'output is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: {},
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: output is not an array`
    );
  })
);

test(
  'output item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: output[0] is not a string`
    );
  })
);

test(
  'output item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            output: [' \t\n '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: output[0] is empty or blank`
    );
  })
);

test(
  'clean is not a boolean or "if-file-deleted"',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            clean: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: clean must be true, false, or "if-file-deleted"`
    );
  })
);

test(
  'packageLocks is not an array',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: 0,
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: packageLocks is not an array`
    );
  })
);

test(
  'packageLocks item is not a string',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: [0],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: packageLocks[0] is not a string`
    );
  })
);

test(
  'packageLocks item is empty or blank',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: [' '],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: packageLocks[0] is empty or blank`
    );
  })
);

test(
  'packageLocks item is not a filename',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            command: 'true',
            packageLocks: ['../package-lock.json'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: packageLocks[0] must be a filename, not a path`
    );
  })
);

test(
  'missing dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['missing'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [missing] No script named "missing" was found in ${rig.temp}`
    );
  })
);

test(
  'duplicate dependency',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'true',
        },
        wireit: {
          a: {
            dependencies: ['b', 'b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] The dependency "b" was declared multiple times`
    );
  })
);

test(
  'script command is not wireit',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'not-wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ package.json:4:10 This command should just be "wireit", as this script is configured in the wireit section.
        "b": "not-wireit"
             ~~~~~~~~~~~~

    package.json:12:5 the wireit config is here
            "b": {
            ~~~
`.trimStart()
    );
  })
);

test(
  'script is wireit but has no wireit config',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {},
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: script has no wireit config`
    );
  })
);

test(
  'script has no command and no dependencies',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {},
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: script has no command and no dependencies`
    );
  })
);

test(
  "cross-package dependency doesn't have a colon",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: Cross-package dependency must use syntax "<relative-path>:<script-name>", but there was no ":" character in "../foo".
`
    );
  })
);

test(
  "cross-package dependency doesn't have a script name",
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: Cross-package dependency must use syntax "<relative-path>:<script-name>", but there was no script name in "../foo:".
`
    );
  })
);

test(
  'cross-package dependency resolves to the same package (".")',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['.:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: Cross-package dependency ".:b" resolved to the same package.
`
    );
  })
);

test(
  'cross-package dependency resolves to the same package (up and back)',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../foo:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Invalid config: Cross-package dependency "../foo:b" resolved to the same package.
`
    );
  })
);

test(
  'cross-package dependency leads to directory without package.json',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [../bar:b] No package.json was found in ${pathlib.resolve(rig.temp, 'bar')}
`
    );
  })
);

test(
  'cross-package dependency leads to package.json with invalid JSON',
  timeout(async ({rig}) => {
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': 'THIS IS NOT VALID JSON',
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [../bar:b] Invalid JSON syntax in package.json file in ${pathlib.resolve(
        rig.temp,
        'bar'
      )}
`
    );
  })
);

test(
  'cycle of length 1',
  timeout(async ({rig}) => {
    //  a
    //  ^ \
    //  |  |
    //  +--+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [a] Cycle detected
.-> a
\`-- a
`
    );
  })
);

test(
  'cycle of length 2',
  timeout(async ({rig}) => {
    //  a --> b
    //  ^     |
    //  |     |
    //  +-----+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ [a] Cycle detected
.-> a
|   b
\`-- a
`
    );
  })
);

test(
  'cycle of length 3',
  timeout(async ({rig}) => {
    //  a --> b --> c
    //  ^           |
    //  |           |
    //  +-----------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ [a] Cycle detected
.-> a
|   b
|   c
\`-- a
`
    );
  })
);

test(
  '2 cycles of length 1',
  timeout(async ({rig}) => {
    //  a -----> b
    //  ^ \     ^ \
    //  | |     | |
    //  +-+     +-+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['a', 'b'],
          },
          b: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ [a] Cycle detected
.-> a
\`-- a
    `
    );
  })
);

test(
  'cycle with lead up and lead out',
  timeout(async ({rig}) => {
    //  a --> b --> c --> d --> e
    //        ^           |
    //        |           |
    //        +-----------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['e', 'b'],
          },
          e: {
            command: 'true',
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
`
    );
  })
);

test(
  'cycle with multiple trails',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['b', 'c'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
  ❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
      `
    );
  })
);

test(
  'cycle with multiple trails (with different dependency order)',
  timeout(async ({rig}) => {
    //    +------+
    //   /        \
    //  /          v
    // a --> b --> c --> d
    //       ^          /
    //        \        /
    //         +------+
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
          d: 'wireit',
          e: 'wireit',
        },
        wireit: {
          a: {
            // The order declared shouldn't affect the path we take to detect
            // the cycle.
            dependencies: ['c', 'b'],
          },
          b: {
            dependencies: ['c'],
          },
          c: {
            dependencies: ['d'],
          },
          d: {
            dependencies: ['b'],
          },
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
  ❌ [b] Cycle detected
    a
.-> b
|   c
|   d
\`-- b
      `
    );
  })
);

test(
  'cycle across packages',
  timeout(async ({rig}) => {
    //  foo:a --> bar:b
    //    ^         |
    //    |         |
    //    +---------+
    await rig.write({
      'foo/package.json': {
        scripts: {
          a: 'wireit',
        },
        wireit: {
          a: {
            dependencies: ['../bar:b'],
          },
        },
      },
      'bar/package.json': {
        scripts: {
          b: 'wireit',
        },
        wireit: {
          b: {
            dependencies: ['../foo:a'],
          },
        },
      },
    });
    const result = rig.exec('npm run a', {cwd: 'foo'});
    const {code, stderr} = await result.exit;
    assert.equal(code, 1);
    assertScriptOutputEquals(
      stderr,
      `
❌ [a] Cycle detected
.-> a
|   ../bar:b
\`-- a
`
    );
  })
);

test(
  'multiple errors',
  timeout(async ({rig}) => {
    await rig.write({
      'package.json': {
        scripts: {
          a: 'wireit',
          b: 'wireit',
          c: 'wireit',
        },
        wireit: {
          a: {
            command: 'foo',
            dependencies: ['b', 'c'],
          },
          b: {},
          c: {},
        },
      },
    });
    const result = rig.exec('npm run a');
    const done = await result.exit;
    assert.equal(done.code, 1);
    assertScriptOutputEquals(
      done.stderr,
      `
❌ [b] Invalid config: script has no command and no dependencies
❌ [c] Invalid config: script has no command and no dependencies`
    );
  })
);

test.run();
