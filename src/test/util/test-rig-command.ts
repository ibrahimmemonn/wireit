/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as net from 'net';
import * as pathlib from 'path';
import {fileURLToPath} from 'url';

import {Deferred} from '../../util/deferred.js';
import {
  type Message,
  MESSAGE_END_MARKER,
} from './test-rig-command-interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathlib.dirname(__filename);
const childModulePath = pathlib.resolve(__dirname, 'test-rig-command-child.js');

/**
 * A unique command which allows us to monitor each time it has been spawned and
 * control when it exits. Takes the place of what would be build programs like
 * "tsc", "rollup" in a real configuration.
 *
 * Instances of this class should be created via the
 * {@link WireitTestRig.command} method.
 */
export class WireitTestRigCommand {
  readonly #ipcPath: string;
  readonly #server: net.Server;
  #state: 'uninitialized' | 'listening' | 'closed' = 'uninitialized';
  #allConnections: Array<net.Socket> = [];
  #newConnections: Array<net.Socket> = [];
  #newConnectionNotification = new Deferred<void>();

  constructor(socketfile: string) {
    this.#ipcPath = socketfile;
    this.#server = net.createServer(this.#onConnection);
  }

  #assertState(expected: 'uninitialized' | 'listening' | 'closed') {
    if (this.#state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this.#state}`
      );
    }
  }

  /**
   * Start listening for connections on the configured socketfile.
   */
  async listen(): Promise<void> {
    this.#assertState('uninitialized');
    this.#state = 'listening';
    return new Promise((resolve, reject) => {
      this.#server.listen(this.#ipcPath);
      this.#server.on('listening', () => resolve());
      this.#server.on('error', (error: Error) => reject(error));
    });
  }

  /**
   * Stop listening for connections.
   */
  async close(): Promise<void> {
    this.#assertState('listening');
    this.#state = 'closed';
    // The server won't close until all connections are destroyed.
    for (const connection of this.#allConnections) {
      connection.destroy();
    }
    return new Promise((resolve, reject) => {
      this.#server.close((error: Error | undefined) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Generate a shell command which will invoke the child Node module,
   * configured to connect to this command's socketfile.
   */
  get command(): string {
    return `node ${childModulePath} ${this.#ipcPath}`;
  }

  /**
   * How many invocations of this command were made.
   */
  get numInvocations(): number {
    return this.#allConnections.length;
  }

  /**
   * Wait for the next invocation of this command. Note that the same command
   * can be invoked multiple times simultaneously.
   */
  async nextInvocation(): Promise<WireitTestRigCommandInvocation> {
    this.#assertState('listening');
    while (true) {
      const socket = this.#newConnections.shift();
      if (socket !== undefined) {
        return new WireitTestRigCommandInvocation(socket, this);
      }
      await this.#newConnectionNotification.promise;
    }
  }

  /**
   * A child connected to our socketfile.
   */
  readonly #onConnection = (socket: net.Socket) => {
    this.#assertState('listening');
    this.#allConnections.push(socket);
    this.#newConnections.push(socket);
    this.#newConnectionNotification.resolve();
    this.#newConnectionNotification = new Deferred();
  };
}

/**
 * One invocation of a {@link WireitTestRigCommand}.
 */
export class WireitTestRigCommandInvocation {
  readonly #socket: net.Socket;
  readonly #socketClosed = new Deferred<void>();
  readonly command: WireitTestRigCommand;
  #state: 'connected' | 'closed' = 'connected';

  constructor(socket: net.Socket, command: WireitTestRigCommand) {
    this.#socket = socket;
    this.#socket.on('close', () => {
      this.#state = 'closed';
      this.#socketClosed.resolve();
    });
    this.command = command;
  }

  #assertState(expected: 'connected' | 'closed') {
    if (this.#state !== expected) {
      throw new Error(
        `Expected state to be ${expected} but was ${this.#state}`
      );
    }
  }

  /**
   * Tell this invocation to exit with the given code.
   */
  exit(code: number): void {
    this.#sendMessage({type: 'exit', code});
    this.#state = 'closed';
  }

  /**
   * Synchronously check if this invocation is still running.
   */
  get running(): boolean {
    return this.#state === 'connected';
  }

  /**
   * Promise that resolves when this invocation's socket has exited, indicating
   * that the process has exited (or is just about to exit).
   */
  get closed(): Promise<void> {
    return this.#socketClosed.promise;
  }

  /**
   * Tell this invocation to write the given string to its stdout stream.
   */
  stdout(str: string): void {
    this.#sendMessage({type: 'stdout', str});
  }

  /**
   * Tell this invocation to write the given string to its stderr stream.
   */
  stderr(str: string): void {
    this.#sendMessage({type: 'stderr', str});
  }

  #sendMessage(message: Message): void {
    this.#assertState('connected');
    this.#socket.write(JSON.stringify(message));
    this.#socket.write(MESSAGE_END_MARKER);
  }
}
