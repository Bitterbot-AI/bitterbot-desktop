/**
 * Shared hardening for node:vm realms that run model-written JavaScript
 * (code_interpreter in-process; the deep_recall RLM sandbox inside its child
 * process, where this is the second layer).
 *
 * Keeping host objects out of the context is not enough. Node installs
 * isolate-wide HOST callbacks that sandbox code can trigger, and when one of
 * them throws, the error it throws is a host-realm object:
 * `e.constructor.constructor("return process")()` then returns the gateway's
 * `process` (found by the red-team pass on the 2026-11-19 report). Two such
 * callbacks are reachable from plain JavaScript:
 *
 *   - Stack-trace formatting. Reading `.stack` runs Node's host formatter,
 *     which throws a host TypeError for e.g. `err.name = Symbol()`, and a host
 *     RangeError when the stack is nearly exhausted.
 *   - Dynamic `import()`. Node rejects it with a host TypeError
 *     (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
 */

/**
 * Run this first in every new realm. With `Error.stackTraceLimit` pinned to
 * undefined V8 captures no stack, so the host formatter is never called;
 * pinning `prepareStackTrace` too keeps sandbox code from re-enabling either.
 * Cost: `.stack` is undefined inside the realm.
 *
 * FinalizationRegistry is removed because an exception thrown from a cleanup
 * callback surfaces as a host `uncaughtException`, which exits the gateway.
 * (An unawaited rejected promise is the sibling case; it is handled in
 * infra/unhandled-rejections.ts via isForeignRealmPromise.)
 */
export const REALM_LOCKDOWN_SOURCE = `"use strict";
Object.defineProperty(Error, "stackTraceLimit", { value: undefined, writable: false, configurable: false });
Object.defineProperty(Error, "prepareStackTrace", { value: undefined, writable: false, configurable: false });
delete globalThis.FinalizationRegistry;
`;

/** Message shown when sandbox code contains the `import` keyword. */
export const IMPORT_REFUSAL_MESSAGE =
  'The word "import" cannot appear in sandbox code (modules are not available). ' +
  'If you need it as text, build it from parts, e.g. "imp" + "ort".';

const IMPORT_TOKEN = /\bimport\b/;

/**
 * Refuse source that contains the `import` keyword. Code generation from
 * strings is disabled in these realms, so `import(...)` can only be reached if
 * the keyword appears literally in the submitted source (keywords cannot be
 * written with unicode escapes). The check is deliberately lexical and
 * over-broad: it also refuses the bare word inside a string or comment, which
 * is safe, and the message tells the model how to write that instead.
 */
export function assertNoImportKeyword(code: string): void {
  if (IMPORT_TOKEN.test(code)) {
    throw new Error(IMPORT_REFUSAL_MESSAGE);
  }
}
