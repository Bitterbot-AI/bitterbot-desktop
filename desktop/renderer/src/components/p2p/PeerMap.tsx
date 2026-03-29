import { useMemo } from "react";

type PeerMapProps = {
  connectedPeers: number;
};

export function PeerMap({ connectedPeers }: PeerMapProps) {
  // Generate peer positions in a radial layout around the center node
  const peers = useMemo(() => {
    const items: Array<{ x: number; y: number; id: number }> = [];
    const count = Math.min(connectedPeers, 24); // Cap visual at 24
    const cx = 150;
    const cy = 100;
    const radius = 70;
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count - Math.PI / 2;
      items.push({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        id: i,
      });
    }
    return items;
  }, [connectedPeers]);

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">Peer Network</h3>
      <svg viewBox="0 0 300 200" className="w-full h-auto">
        {/* Connection lines */}
        {peers.map((peer) => (
          <line
            key={`line-${peer.id}`}
            x1={150}
            y1={100}
            x2={peer.x}
            y2={peer.y}
            stroke="currentColor"
            className="text-muted/30"
            strokeWidth="1"
          />
        ))}

        {/* Peer nodes */}
        {peers.map((peer) => (
          <g key={`peer-${peer.id}`}>
            <circle
              cx={peer.x}
              cy={peer.y}
              r="6"
              fill="currentColor"
              className="text-primary/60"
            />
            <circle
              cx={peer.x}
              cy={peer.y}
              r="6"
              fill="none"
              stroke="currentColor"
              className="text-primary/30 animate-ping"
              strokeWidth="1"
              style={{ animationDelay: `${peer.id * 200}ms`, animationDuration: "3s" }}
            />
          </g>
        ))}

        {/* Center node (self) */}
        <circle cx={150} cy={100} r="10" fill="currentColor" className="text-primary" />
        <circle
          cx={150}
          cy={100}
          r="10"
          fill="none"
          stroke="currentColor"
          className="text-primary/40 animate-ping"
          strokeWidth="2"
          style={{ animationDuration: "2s" }}
        />
        <text
          x={150}
          y={130}
          textAnchor="middle"
          className="fill-muted-foreground text-[10px]"
        >
          You
        </text>

        {connectedPeers === 0 && (
          <text
            x={150}
            y={105}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            No peers connected
          </text>
        )}

        {connectedPeers > 24 && (
          <text
            x={150}
            y={190}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px]"
          >
            +{connectedPeers - 24} more peers
          </text>
        )}
      </svg>
    </div>
  );
}
