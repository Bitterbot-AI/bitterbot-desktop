import { DatabaseSync } from "node:sqlite";

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await import("sqlite-vec");
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    params.db.enableLoadExtension(true);
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Probe whether vector search will actually work on this machine.
 *
 * Loading the extension is not enough — verify a `vec0` virtual table can be
 * created and dropped, which exercises the native code path memory search
 * depends on. Runs against a throwaway in-memory database so it has no side
 * effects, making it safe to call from onboarding/doctor before any store
 * exists. Returns `ok: false` with a reason instead of throwing, so callers can
 * surface "vector search active" vs "degraded to keyword-only" to the user
 * rather than letting the failure stay silent.
 */
export async function probeSqliteVec(
  extensionPath?: string,
): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(":memory:", { allowExtension: true });
    const loaded = await loadSqliteVecExtension({ db, extensionPath });
    if (!loaded.ok) {
      return { ok: false, error: loaded.error };
    }
    db.exec("CREATE VIRTUAL TABLE __vec_probe USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])");
    db.exec("DROP TABLE __vec_probe");
    return { ok: true, extensionPath: loaded.extensionPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}
