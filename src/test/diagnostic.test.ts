/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {suite} from 'uvu';
import * as assert from 'uvu/assert';
import {drawSquiggle, Location} from '../error.js';

const test = suite();

function makeFakeLocation(
  offset: number,
  length: number,
  contents: string
): Location {
  return {
    range: {
      offset,
      length,
    },
    file: {
      path: 'package.json',
      ast: null!,
      contents,
    },
  };
}

test('drawing squiggles under ranges in single-line files', () => {
  assert.equal(drawSquiggle(makeFakeLocation(0, 0, 'H'), 0), 'H\n');

  assert.equal(drawSquiggle(makeFakeLocation(0, 1, 'H'), 0), 'H\n~');

  assert.equal(
    drawSquiggle(makeFakeLocation(3, 3, 'aaabbbccc'), 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(3, 3, 'aaabbbccc'), 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles single-line ranges at the end of multi-line files', () => {
  assert.equal(drawSquiggle(makeFakeLocation(4, 0, 'abc\nH\n'), 0), 'H\n');

  assert.equal(drawSquiggle(makeFakeLocation(4, 1, 'abc\nH\n'), 0), 'H\n~');

  assert.equal(
    drawSquiggle(makeFakeLocation(7, 3, 'abc\naaabbbccc'), 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(7, 3, 'abc\naaabbbccc'), 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles under multi-line ranges', () => {
  assert.equal(drawSquiggle(makeFakeLocation(0, 0, 'H\nabc'), 0), 'H\n');

  assert.equal(drawSquiggle(makeFakeLocation(0, 1, 'H\nabc'), 0), 'H\n~');

  assert.equal(
    drawSquiggle(makeFakeLocation(3, 3, 'aaabbbccc\nabc'), 0),
    `
aaabbbccc
   ~~~`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(3, 3, 'aaabbbccc\nabc'), 8),
    `
        aaabbbccc
           ~~~`.slice(1)
  );
});

test('drawing squiggles under multi-line ranges', () => {
  assert.equal(
    drawSquiggle(makeFakeLocation(0, 0, 'abc\ndef\nhij'), 0),
    `
abc
`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(0, 5, 'abc\ndef\nhij'), 0),
    `
abc
~~~
def
~`.slice(1)
  );

  // include the newline at the end of the first line
  assert.equal(
    drawSquiggle(makeFakeLocation(0, 4, 'abc\ndef\nhij'), 0),
    `
abc
~~~
def
`.slice(1)
  );

  // include _only_ the newline at the end of the first line
  assert.equal(
    drawSquiggle(makeFakeLocation(3, 1, 'abc\ndef\nhij'), 0),
    `
abc
${'   '}
def
`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(3, 2, 'abc\ndef\nhij'), 0),
    `
abc
${'   '}
def
~`.slice(1)
  );

  assert.equal(
    drawSquiggle(makeFakeLocation(2, 7, 'abc\ndef\nhij'), 0),
    `
abc
  ~
def
~~~
hij
~`.slice(1)
  );
});

test.run();
