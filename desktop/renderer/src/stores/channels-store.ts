import { create } from "zustand";
import type { ChannelStatus } from "../types/gateway-protocol";

interface ChannelsState {
  channels: ChannelStatus[];
  loading: boolean;
  setChannels: (channels: ChannelStatus[]) => void;
  updateChannel: (id: string, update: Partial<ChannelStatus>) => void;
  setLoading: (loading: boolean) => void;
}

export const useChannelsStore = create<ChannelsState>((set) => ({
  channels: [],
  loading: false,

  setChannels: (channels) => set({ channels }),

  updateChannel: (id, update) =>
    set((s) => ({
      channels: s.channels.map((ch) =>
        ch.id === id ? { ...ch, ...update } : ch,
      ),
    })),

  setLoading: (loading) => set({ loading }),
}));
