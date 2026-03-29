interface BitterBotAvatarProps {
  size?: number;
  variant?: "circle" | "logo";
  isThinking?: boolean;
}

/**
 * Animated eyes overlaid on the true Bitterbot logo SVG.
 * Eyes sit in the upper counter spaces of each "b" letterform.
 * Positions are percentages relative to the avatar image bounding box.
 */
function ThinkingEyes({ size }: { size: number }) {
  // Eye positions as % of the avatar image — tuned to the upper "b" counters
  // Left eye center: ~33% x, ~37% y  |  Right eye center: ~67% x, ~37% y
  const eyeR = size * 0.09;
  const pupilR = size * 0.05;

  // Wandering translation values
  const t = (f: number) => (size * f).toFixed(1);
  const wander = `0,0; ${t(0.02)},0; ${t(0.02)},${t(-0.01)}; ${t(-0.01)},${t(0.01)}; ${t(-0.02)},0; 0,${t(-0.01)}; ${t(0.01)},${t(0.01)}; 0,0`;
  const wanderTimes = "0; 0.15; 0.3; 0.45; 0.6; 0.75; 0.9; 1";

  // Blink: ry goes full → squished → full, with long pauses between blinks
  // ~3.5s cycle: open 85% of the time, quick blink at the end
  const blinkEye = `${eyeR}; ${eyeR}; ${eyeR * 0.1}; ${eyeR}; ${eyeR}`;
  const blinkPupil = `${pupilR}; ${pupilR}; ${pupilR * 0.1}; ${pupilR}; ${pupilR}`;
  const blinkTimes = "0; 0.85; 0.9; 0.95; 1";

  const lx = size * 0.335;
  const rx = size * 0.665;
  const ey = size * 0.37;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
      className="absolute inset-0"
      style={{ pointerEvents: "none" }}
    >
      {/* Left eye — white/glow */}
      <ellipse cx={lx} cy={ey} rx={eyeR} ry={eyeR} fill="#e9d5ff" opacity="0.9">
        <animateTransform attributeName="transform" type="translate" values={wander} keyTimes={wanderTimes} dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="ry" values={blinkEye} keyTimes={blinkTimes} dur="3.5s" repeatCount="indefinite" />
      </ellipse>
      {/* Left eye — pupil */}
      <ellipse cx={lx} cy={ey} rx={pupilR} ry={pupilR} fill="#4c1d95">
        <animateTransform attributeName="transform" type="translate" values={wander} keyTimes={wanderTimes} dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="ry" values={blinkPupil} keyTimes={blinkTimes} dur="3.5s" repeatCount="indefinite" />
      </ellipse>
      {/* Right eye — white/glow */}
      <ellipse cx={rx} cy={ey} rx={eyeR} ry={eyeR} fill="#e9d5ff" opacity="0.9">
        <animateTransform attributeName="transform" type="translate" values={wander} keyTimes={wanderTimes} dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="ry" values={blinkEye} keyTimes={blinkTimes} dur="3.5s" repeatCount="indefinite" />
      </ellipse>
      {/* Right eye — pupil */}
      <ellipse cx={rx} cy={ey} rx={pupilR} ry={pupilR} fill="#4c1d95">
        <animateTransform attributeName="transform" type="translate" values={wander} keyTimes={wanderTimes} dur="2.5s" repeatCount="indefinite" />
        <animate attributeName="ry" values={blinkPupil} keyTimes={blinkTimes} dur="3.5s" repeatCount="indefinite" />
      </ellipse>
    </svg>
  );
}

export function BitterBotAvatar({
  size = 32,
  variant = "logo",
  isThinking = false,
}: BitterBotAvatarProps) {
  if (variant === "logo") {
    return (
      <div
        className="bb-avatar flex items-center justify-center flex-shrink-0 relative"
        style={{ width: size, height: size }}
      >
        <img
          src="/bitterbot_avatar.png"
          alt="BitterBot"
          width={size}
          height={size}
          className="object-contain"
        />
        {isThinking && <ThinkingEyes size={size} />}
      </div>
    );
  }

  // Circle variant
  return (
    <div
      className="bb-avatar-circle flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: "linear-gradient(135deg, #8b5cf6, #7c3aed)",
        borderRadius: "50%",
        boxShadow: "0 2px 8px rgba(139, 92, 246, 0.3)",
      }}
    >
      <span
        className="text-white font-bold"
        style={{ fontSize: size * 0.4 }}
      >
        BB
      </span>
    </div>
  );
}
