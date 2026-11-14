/**
 * Node globals that the NEAR wallet-selector libraries expect in the browser.
 * Imported FIRST in main.tsx: ES modules evaluate imports in order, so these
 * must exist before any wallet module is evaluated.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string>; browser: boolean; version: string } };
g.Buffer ??= Buffer;
g.process ??= { env: {}, browser: true, version: "" };
