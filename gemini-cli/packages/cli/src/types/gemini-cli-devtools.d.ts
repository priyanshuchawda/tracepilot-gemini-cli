/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare module '@google/gemini-cli-devtools' {
  export interface IDevToolsInstance {
    start(): Promise<string>;
    stop(): Promise<void>;
    getPort(): number;
  }

  export class DevTools {
    static getInstance(): IDevToolsInstance;
  }
}
