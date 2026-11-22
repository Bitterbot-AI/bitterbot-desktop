import { ArrowUp, Camera, ImagePlus, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { useMobile } from "../store";

type Attachment = { id: string; name: string; mimeType: string; data: string; preview: string };

const MAX_IMAGE_EDGE = 2048;
const MAX_TEXT_FILE_BYTES = 200_000;
const TEXT_FILE =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|log|xml|html?|css|js|ts|tsx|py|sh|toml|ini)$/i;

/** Re-encode a photo as JPEG no larger than 2048px, well under the gateway's 5 MB cap. */
async function encodeImage(
  file: File,
): Promise<{ data: string; mimeType: string; preview: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.addEventListener("load", () => resolve(el));
      el.addEventListener("error", () => reject(new Error("This image could not be read.")));
      el.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { data: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg", preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")));
    reader.readAsDataURL(blob);
  });
}

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported?.(mime)) return mime;
  }
  return undefined;
}

export function Composer() {
  const send = useMobile((s) => s.send);
  const abort = useMobile((s) => s.abort);
  const request = useMobile((s) => s.request);
  const running = useMobile((s) => Boolean(s.run));
  const online = useMobile((s) => s.conn === "online");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Grow with the text up to ~6 lines, without layout jumps.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const canSend = online && !running && (text.trim().length > 0 || attachments.length > 0);
  const voiceSupported =
    typeof navigator.mediaDevices?.getUserMedia === "function" && Boolean(pickRecorderMime());

  const submit = useCallback(async () => {
    if (!canSend) return;
    const message = text;
    const images = attachments.map((a) => ({ mimeType: a.mimeType, data: a.data, name: a.name }));
    setText("");
    setAttachments([]);
    await send(message, images);
  }, [attachments, canSend, send, text]);

  const onFiles = useCallback(async (files: FileList | null) => {
    setMenuOpen(false);
    if (!files) return;
    for (const file of Array.from(files).slice(0, 4)) {
      try {
        if (file.type.startsWith("image/")) {
          const encoded = await encodeImage(file);
          setAttachments((prev) => [
            ...prev,
            { id: `${Date.now()}-${prev.length}`, name: file.name || "photo.jpg", ...encoded },
          ]);
        } else if (TEXT_FILE.test(file.name) || file.type.startsWith("text/")) {
          if (file.size > MAX_TEXT_FILE_BYTES) {
            toast.error("That file is too large to paste into the chat.");
            continue;
          }
          const content = await file.text();
          setText(
            (prev) => `${prev}${prev ? "\n\n" : ""}${file.name}:\n\`\`\`\n${content}\n\`\`\``,
          );
        } else {
          toast.error("Photos and text files can be attached. Other files are not supported yet.");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not attach that file.");
      }
    }
  }, []);

  const startRecording = useCallback(async () => {
    const mimeType = pickRecorderMime();
    if (!mimeType) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const audio = await blobToBase64(blob);
          const res = await request<{ text: string }>(
            "talk.transcribe",
            { audio, mimeType: mimeType.split(";")[0] },
            60_000,
          );
          setText((prev) => (prev ? `${prev} ${res.text}` : res.text));
          textareaRef.current?.focus();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not transcribe that.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      toast.error("Microphone access was not allowed.");
    }
  }, [request]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  return (
    <div className="mobile-composer">
      {attachments.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {attachments.map((a) => (
            <div key={a.id} className="m-fade-in relative size-16 shrink-0">
              <img src={a.preview} alt={a.name} className="size-16 rounded-xl object-cover" />
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-foreground text-background"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {menuOpen && (
        <div className="m-fade-in mb-2 grid grid-cols-3 gap-2">
          {[
            { label: "Camera", icon: Camera, ref: cameraRef },
            { label: "Photos", icon: ImagePlus, ref: photoRef },
            { label: "File", icon: Paperclip, ref: fileRef },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => item.ref.current?.click()}
              className="m-press m-card flex h-16 flex-col items-center justify-center gap-1 text-xs text-foreground"
            >
              <item.icon className="size-5 text-primary" />
              {item.label}
            </button>
          ))}
        </div>
      )}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      <input
        ref={photoRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => void onFiles(e.target.files)}
      />
      <input ref={fileRef} type="file" hidden onChange={(e) => void onFiles(e.target.files)} />

      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label={menuOpen ? "Close attachments" : "Attach"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(
            "m-touch m-press flex shrink-0 items-center justify-center rounded-full text-muted-foreground",
            menuOpen && "text-primary",
          )}
        >
          <Plus
            className="size-6 transition-transform duration-[var(--motion-duration-fast)]"
            style={{ transform: menuOpen ? "rotate(45deg)" : undefined }}
          />
        </button>
        <div className="flex min-h-11 flex-1 items-end rounded-3xl border border-[var(--m-hairline)] bg-[var(--m-surface-strong)] pl-4 pr-1.5 focus-within:border-primary/60">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(hover: hover)").matches) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder={
              recording ? "Listening…" : transcribing ? "Transcribing…" : "Message Bitterbot"
            }
            enterKeyHint="send"
            className="m-input max-h-40 flex-1 resize-none bg-transparent py-2.5 leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={() => void abort()}
              className="m-press my-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : canSend ? (
            <button
              type="button"
              aria-label="Send"
              onClick={() => void submit()}
              className="m-press my-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <ArrowUp className="size-5" strokeWidth={2.5} />
            </button>
          ) : voiceSupported ? (
            <button
              type="button"
              aria-label={recording ? "Stop recording" : "Speak"}
              disabled={!online || transcribing}
              onClick={() => (recording ? stopRecording() : void startRecording())}
              className={cn(
                "m-press relative my-1 flex size-9 shrink-0 items-center justify-center rounded-full",
                recording ? "bg-danger text-danger-foreground" : "text-muted-foreground",
              )}
            >
              {recording && <span className="m-pulse-ring" />}
              {transcribing ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <Mic className="size-5" />
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
