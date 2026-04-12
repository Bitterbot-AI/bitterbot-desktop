import { useEffect } from "react";
import type { GatewayEventFrame } from "../lib/gateway-client";
import { useGatewayStore } from "../stores/gateway-store";

/**
 * Subscribe to gateway events by event name.
 * The callback fires whenever a matching event arrives.
 */
export function useGatewayEvent(eventName: string, callback: (payload: unknown) => void) {
  const subscribe = useGatewayStore((s) => s.subscribe);

  useEffect(() => {
    const handler = (evt: GatewayEventFrame) => {
      if (evt.event === eventName) {
        callback(evt.payload);
      }
    };
    return subscribe(handler);
  }, [eventName, callback, subscribe]);
}
