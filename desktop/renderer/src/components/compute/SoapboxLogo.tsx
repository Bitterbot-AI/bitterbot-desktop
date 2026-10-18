import wordmark from "./assets/soapbox-wordmark.png";

/** Preserve the original brand colours and contrast in either app theme. */
export function SoapboxLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-lg bg-[#f5f5f7] px-3 py-2 ring-1 ring-black/5">
      <img
        src={wordmark}
        alt={compact ? "" : "Soapbox"}
        width={1575}
        height={355}
        className={compact ? "h-auto w-28" : "h-auto w-40 sm:w-48"}
        draggable={false}
      />
    </span>
  );
}
