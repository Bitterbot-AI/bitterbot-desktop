import { create } from "zustand";

/**
 * What a person left behind in each conversation: the unsent text and where
 * they were reading. Switching away and back restores both. Kept for the life
 * of the window only; an unsent draft is not something to write to disk.
 */
interface DraftState {
  drafts: Record<string, string>;
  /** Distance from the top of the transcript, in pixels, per conversation. */
  scroll: Record<string, number>;
  setDraft: (sessionKey: string, text: string) => void;
  setScroll: (sessionKey: string, top: number) => void;
  /** Forget a conversation, for example once it is deleted. */
  forget: (sessionKey: string) => void;
}

/** Enough to cover a working session without growing forever. */
const MAX_REMEMBERED = 50;

function bounded<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length <= MAX_REMEMBERED
    ? record
    : Object.fromEntries(entries.slice(entries.length - MAX_REMEMBERED));
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  scroll: {},
  setDraft: (sessionKey, text) =>
    set((s) => {
      const { [sessionKey]: _previous, ...rest } = s.drafts;
      // Re-inserting keeps the most recently edited draft last, so the bound
      // drops the oldest one.
      return { drafts: text ? bounded({ ...rest, [sessionKey]: text }) : rest };
    }),
  setScroll: (sessionKey, top) =>
    set((s) => {
      const { [sessionKey]: _previous, ...rest } = s.scroll;
      return { scroll: bounded({ ...rest, [sessionKey]: top }) };
    }),
  forget: (sessionKey) =>
    set((s) => {
      const { [sessionKey]: _draft, ...drafts } = s.drafts;
      const { [sessionKey]: _scroll, ...scroll } = s.scroll;
      return { drafts, scroll };
    }),
}));
