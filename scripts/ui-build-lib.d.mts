/** Types for scripts/ui-build-lib.mjs (the `pnpm ui:build` skip gate's input hash). */

export declare const UI_HASH_SKIP_DIRS: Set<string>;
export declare const UI_HASH_ROOT_FILES: string[];
export declare const UI_HASH_ENV_KEYS: string[];
export declare function computeUiInputHash(repoRoot: string, env?: NodeJS.ProcessEnv): string;
