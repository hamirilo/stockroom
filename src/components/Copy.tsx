// Copying text from a dialog: the button itself says it worked ("コピーしました"
// for a moment) instead of a toast in the corner, away from where the user
// looks (docs/NOTIFICATIONS.md). A failure is still a toast.
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const SHOWN_MS = 1500;

/** `[copied, copy]`: `copied` is true for a moment after `copy(text)` worked. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), SHOWN_MS);
      },
      (e) => useStore.getState().toast(String(e), true),
    );
  return [copied, copy];
}

/**
 * The icon and label of a copy button. Both labels take the same room, so
 * the button keeps its width (docs/UI.md).
 */
export function CopyLabel({ copied }: { copied: boolean }) {
  return (
    <>
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      <span className="grid">
        <span className={`col-start-1 row-start-1 ${copied ? "invisible" : ""}`}>コピー</span>
        <span className={`col-start-1 row-start-1 text-success ${copied ? "" : "invisible"}`}>コピーしました</span>
      </span>
    </>
  );
}

/** Text in a sentence that copies itself on a click; "コピーしました" shows above it. */
export function CopyCode({ text }: { text: string }) {
  const [copied, copy] = useCopy();
  return (
    <button
      onClick={() => copy(text)}
      title="クリックでコピー"
      className="relative rounded bg-bg px-1 font-mono text-fg hover:text-accent"
    >
      {text}
      {copied && (
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 animate-fade-in rounded bg-raised px-1.5 py-0.5 font-sans text-[11px] whitespace-nowrap text-success shadow-lg ring-1 ring-line">
          コピーしました
        </span>
      )}
    </button>
  );
}
