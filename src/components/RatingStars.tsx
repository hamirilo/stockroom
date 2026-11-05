import { Star } from "lucide-react";
import { useState } from "react";

/** Click a star to rate; clicking the current rating clears it. `null` = mixed. */
export function RatingStars({
  value,
  onChange,
  size = 16,
}: {
  value: number | null;
  onChange: (n: number) => void;
  size?: number;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  return (
    <div className="flex items-center gap-0.5" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          title={`★${n}（キー ${n}）`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(n === value ? 0 : n)}
          className="p-0.5 transition-transform hover:scale-125"
        >
          <Star
            size={size}
            strokeWidth={1.5}
            className={n <= shown ? "text-amber-500 dark:text-amber-400" : "text-dim/50"}
            fill={n <= shown ? "currentColor" : "none"}
          />
        </button>
      ))}
      {value === null && <span className="ml-1 text-[11px] text-dim">（混在）</span>}
    </div>
  );
}
