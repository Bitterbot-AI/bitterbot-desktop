import { useState } from "react";
import { useGatewayStore } from "../../stores/gateway-store";

export function ArtifactPanel() {
  const request = useGatewayStore((s) => s.request);
  const [content, setContent] = useState("");
  const [id, setId] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (save: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (save) {
        const value = await request<{ id: string }>("soapbox.artifact.put", {
          content,
          ttl_seconds: 3600,
        });
        setId(value.id);
        setResult(value);
      } else {
        setResult(await request("soapbox.artifact.get", { id }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-xl border border-border p-5 space-y-3">
      <h2 className="font-medium">Temporary artifacts</h2>
      <p className="text-sm text-muted-foreground">
        Private to this account. Stored for one hour on the coordinator. This pilot storage is
        unreplicated and is not a backup service.
      </p>
      <label className="block text-sm">
        Text content
        <textarea
          className="block w-full rounded-lg border border-border bg-background p-2"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <button
        className="rounded-lg bg-muted px-3 py-2 text-sm"
        disabled={busy || !content}
        onClick={() => void run(true)}
      >
        Store for one hour
      </button>
      <label className="block text-sm">
        Artifact ID
        <input
          className="block w-full rounded-lg border border-border bg-background p-2"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <button
        className="rounded-lg bg-muted px-3 py-2 text-sm"
        disabled={busy || !id}
        onClick={() => void run(false)}
      >
        Retrieve artifact
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {result !== null && (
        <pre className="max-h-40 overflow-auto text-xs whitespace-pre-wrap">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </section>
  );
}
