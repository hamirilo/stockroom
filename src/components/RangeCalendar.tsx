// Inline date-range calendar (the native date picker can't be styled).
// Click a day, then another to make a range; a single click picks that day.
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useMemo, useState } from "react";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime();

interface Props {
  /** First day, inclusive (ms at local midnight). */
  from: number | null;
  /** Last day, inclusive (ms at local midnight). */
  to: number | null;
  /** Latest selectable day (default: today). */
  max?: Date;
  onChange: (from: number, to: number) => void;
}

export function RangeCalendar({ from, to, max = dayStart(new Date()), onChange }: Props) {
  const start = from != null ? dayStart(new Date(from)) : null;
  const end = to != null ? dayStart(new Date(to)) : start;
  const [month, setMonth] = useState(() => {
    const base = end ?? start ?? max;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  // First click of a range in progress, and the day under the pointer.
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [hover, setHover] = useState<Date | null>(null);

  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const lead = first.getDay();
    return Array.from({ length: 42 }, (_, i) => addDays(first, i - lead));
  }, [month]);

  // What to paint as the range: the pending one while choosing, else the saved one.
  const [lo, hi] = anchor
    ? [anchor, hover ?? anchor].sort((a, b) => a.getTime() - b.getTime())
    : [start, end];

  const pick = (d: Date) => {
    if (d > max) return;
    if (!anchor) {
      setAnchor(d);
      onChange(d.getTime(), d.getTime());
    } else {
      const [a, b] = [anchor, d].sort((x, y) => x.getTime() - y.getTime());
      setAnchor(null);
      onChange(a.getTime(), b.getTime());
    }
  };

  const shift = (months: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + months, 1));
  const nav = "flex h-7 w-7 items-center justify-center rounded text-dim hover:bg-white/10 hover:text-fg";
  const nextDisabled = new Date(month.getFullYear(), month.getMonth() + 1, 1) > max;
  const nextYearDisabled = new Date(month.getFullYear() + 1, month.getMonth(), 1) > max;

  return (
    <div className="w-[238px] select-none p-1" onPointerLeave={() => setHover(null)}>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex">
          <button className={nav} title="前の年" onClick={() => shift(-12)}>
            <ChevronsLeft size={14} />
          </button>
          <button className={nav} title="前の月" onClick={() => shift(-1)}>
            <ChevronLeft size={14} />
          </button>
        </div>
        <button
          title="今月へ"
          onClick={() => setMonth(new Date(max.getFullYear(), max.getMonth(), 1))}
          className="rounded px-2 py-1 font-medium tabular-nums hover:bg-white/10"
        >
          {month.getFullYear()}年{month.getMonth() + 1}月
        </button>
        <div className="flex">
          <button className={`${nav} disabled:off`} title="次の月" disabled={nextDisabled} onClick={() => shift(1)}>
            <ChevronRight size={14} />
          </button>
          <button
            className={`${nav} disabled:off`}
            title="次の年"
            disabled={nextYearDisabled}
            onClick={() => shift(12)}
          >
            <ChevronsRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center text-[11px]">
        {WEEK.map((w, i) => (
          <div key={w} className={`py-1 ${i === 0 ? "text-danger/80" : i === 6 ? "text-accent/80" : "text-dim"}`}>
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const disabled = d > max;
          const inRange = lo && hi && d >= lo && d <= hi;
          const edge = (lo && sameDay(d, lo)) || (hi && sameDay(d, hi));
          const today = sameDay(d, dayStart(new Date()));
          return (
            <button
              key={d.getTime()}
              disabled={disabled}
              onClick={() => pick(d)}
              onPointerEnter={() => setHover(d)}
              className={`relative h-8 text-xs tabular-nums disabled:cursor-default disabled:off ${
                edge
                  ? "rounded-md bg-accent-fill font-medium text-white"
                  : inRange
                    ? "bg-accent/25"
                    : disabled
                      ? ""
                      : "rounded-md hover:bg-white/10"
              } ${inMonth || edge ? "" : "text-dim/50"}`}
            >
              {d.getDate()}
              {today && !edge && <span className="absolute inset-x-0 bottom-0.5 mx-auto h-0.5 w-3 rounded-full bg-accent" />}
            </button>
          );
        })}
      </div>

      <p className="px-1 pt-2 text-[11px] text-dim">
        {anchor ? "終わりの日を選んでください" : "1日だけ選ぶか、始めと終わりの日を選びます"}
      </p>
    </div>
  );
}
