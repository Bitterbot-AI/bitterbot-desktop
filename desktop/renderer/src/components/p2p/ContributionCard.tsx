type ContributionCardProps = {
  title: string;
  value: number | string;
  icon: "users" | "upload" | "download" | "trophy";
};

const ICONS: Record<string, string> = {
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 14v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  trophy:
    "M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22m7-7.34V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z",
};

export function ContributionCard({ title, value, icon }: ContributionCardProps) {
  const maxForRing = typeof value === "number" ? Math.min(value, 100) : 0;
  const ringPct = (maxForRing / 100) * 100;
  const circumference = 2 * Math.PI * 20;
  const strokeDash = (ringPct / 100) * circumference;

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 flex items-center gap-4">
      {/* Animated ring */}
      <div className="relative w-14 h-14 flex-shrink-0">
        <svg viewBox="0 0 48 48" className="w-full h-full -rotate-90">
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="currentColor"
            className="text-muted/20"
            strokeWidth="3"
          />
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="currentColor"
            className="text-primary transition-all duration-700 ease-out"
            strokeWidth="3"
            strokeDasharray={`${strokeDash} ${circumference}`}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5 text-muted-foreground"
          >
            <path d={ICONS[icon]} />
          </svg>
        </div>
      </div>

      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-xs text-muted-foreground">{title}</div>
      </div>
    </div>
  );
}
