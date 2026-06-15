"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const WHEEL_EMOTIONS = [
  { emoji: "😄", label: "Excited" },
  { emoji: "🥳", label: "Joyful" },
  { emoji: "😊", label: "Happy" },
  { emoji: "🥰", label: "Loved" },
  { emoji: "😌", label: "Calm" },
  { emoji: "😇", label: "Grateful" },
  { emoji: "💪", label: "Motivated" },
  { emoji: "😎", label: "Confident" },
  { emoji: "🤩", label: "Amazed" },
  { emoji: "😏", label: "Playful" },
  { emoji: "😐", label: "Neutral" },
  { emoji: "🤔", label: "Confused" },
  { emoji: "😔", label: "Down" },
  { emoji: "😢", label: "Sad" },
  { emoji: "😞", label: "Disappointed" },
  { emoji: "😰", label: "Anxious" },
  { emoji: "😨", label: "Scared" },
  { emoji: "😫", label: "Exhausted" },
  { emoji: "😡", label: "Angry" },
  { emoji: "😤", label: "Frustrated" },
];

const TUT_STEPS = [0, 3, 6, 9, 13, 17];

export function EmotionWheel({ selected, onSelect }: { selected: string; onSelect: (emoji: string) => void }) {
  const [hovered, setHovered] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const [tutStep, setTutStep] = useState<number | null>(0);
  const tutTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const size = 260;
  const center = size / 2;
  const radius = 100;
  const n = WHEEL_EMOTIONS.length;

  const stopTutorial = useCallback(() => {
    tutTimers.current.forEach(clearTimeout);
    tutTimers.current = [];
    setTutStep(null);
    setHovered("");
  }, []);

  useEffect(() => {
    const DELAY = 500;
    const STEP = 320;
    TUT_STEPS.forEach((idx, i) => {
      const t = setTimeout(() => {
        setTutStep(i);
        setHovered(WHEEL_EMOTIONS[idx].emoji);
      }, DELAY + i * STEP);
      tutTimers.current.push(t);
    });
    const end = setTimeout(() => {
      setHovered("");
      setTutStep(null);
    }, DELAY + TUT_STEPS.length * STEP);
    tutTimers.current.push(end);
    return () => { tutTimers.current.forEach(clearTimeout); };
  }, []);

  const displayEmotion = WHEEL_EMOTIONS.find((e) => e.emoji === (hovered || selected));
  const isPreview = !!hovered && hovered !== selected;

  const tutPos = tutStep !== null && tutStep < TUT_STEPS.length ? (() => {
    const idx = TUT_STEPS[tutStep];
    const angle = (idx / n) * 2 * Math.PI - Math.PI / 2;
    return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
  })() : null;

  const emojiAtPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    let target: Element | null = el;
    while (target && target !== containerRef.current) {
      const v = target.getAttribute("data-emoji");
      if (v) return v;
      target = target.parentElement;
    }
    return null;
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onMove = (e: TouchEvent) => {
      stopTutorial();
      const t = e.touches[0];
      setHovered(emojiAtPoint(t.clientX, t.clientY) ?? "");
    };
    const onEnd = () => {
      setHovered((prev) => {
        if (prev) onSelect(prev);
        return "";
      });
    };
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [onSelect, stopTutorial]);

  return (
    <div ref={containerRef} className="relative mx-auto flex-shrink-0" style={{ width: size, height: size }}>
      <div
        className="absolute rounded-full border border-gray-100"
        style={{
          width: radius * 2 + 36,
          height: radius * 2 + 36,
          left: center - radius - 18,
          top: center - radius - 18,
        }}
      />
      {tutPos && (
        <div
          className="absolute z-20 pointer-events-none -translate-x-1/2 -translate-y-1/2"
          style={{ left: tutPos.x, top: tutPos.y, transition: "left 0.28s ease, top 0.28s ease" }}
        >
          <div className="w-8 h-8 rounded-full bg-indigo-400/30 ring-2 ring-indigo-400/60 animate-ping" />
        </div>
      )}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center px-4">
          {displayEmotion ? (
            <>
              <div className={`text-3xl leading-none transition-all duration-150 ${isPreview ? "scale-125" : ""}`}>
                {displayEmotion.emoji}
              </div>
              <div className={`text-xs font-semibold mt-1 transition-colors ${isPreview ? "text-gray-600" : "text-gray-700"}`}>
                {displayEmotion.label}
              </div>
            </>
          ) : (
            <div className="text-[10px] text-gray-300 leading-tight text-center">slide to<br />explore</div>
          )}
        </div>
      </div>
      {WHEEL_EMOTIONS.map((emotion, i) => {
        const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
        const x = center + radius * Math.cos(angle);
        const y = center + radius * Math.sin(angle);
        const isSelected = selected === emotion.emoji;
        const isHovered = hovered === emotion.emoji;
        return (
          <button
            key={emotion.emoji}
            data-emoji={emotion.emoji}
            onClick={() => { stopTutorial(); onSelect(emotion.emoji); }}
            onMouseEnter={() => { stopTutorial(); setHovered(emotion.emoji); }}
            onMouseLeave={() => setHovered("")}
            className={`absolute flex items-center justify-center rounded-full transition-all duration-100 -translate-x-1/2 -translate-y-1/2 ${
              isSelected
                ? "w-11 h-11 text-2xl bg-indigo-100 ring-2 ring-indigo-400 z-10"
                : isHovered
                ? "w-11 h-11 text-2xl bg-gray-100 z-10"
                : "w-9 h-9 text-xl"
            }`}
            style={{ left: x, top: y }}
          >
            {emotion.emoji}
          </button>
        );
      })}
    </div>
  );
}

export function MoodModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (emoji: string, text: string) => void;
  onClose: () => void;
}) {
  const [selectedEmoji, setSelectedEmoji] = useState("");
  const [text, setText] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customEmotion, setCustomEmotion] = useState("");

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const effectiveEmoji = customMode ? customEmotion.trim() : selectedEmoji;

  function handleWheelSelect(emoji: string) {
    setSelectedEmoji(emoji);
    setCustomMode(false);
    setCustomEmotion("");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full sm:max-w-sm rounded-t-3xl sm:rounded-2xl bg-white shadow-xl pt-5 pb-8 px-5 sm:pb-5 space-y-4">
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto sm:hidden" />
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🧠</span>
            <h2 className="text-base font-semibold text-gray-900">Emotional Check-in</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none">
            ✕
          </button>
        </div>

        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">How are you feeling?</p>
        <EmotionWheel selected={customMode ? "" : selectedEmoji} onSelect={handleWheelSelect} />

        {customMode ? (
          <div className="space-y-1">
            <input
              type="text"
              value={customEmotion}
              onChange={(e) => setCustomEmotion(e.target.value)}
              placeholder="describe the feeling in your own words…"
              className="w-full border border-indigo-300 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              autoFocus
            />
            <p className="text-[11px] text-gray-400 text-center">or tap the wheel to pick an emotion</p>
          </div>
        ) : (
          <button
            onClick={() => { setCustomMode(true); setSelectedEmoji(""); }}
            className="text-xs text-gray-400 hover:text-indigo-500 underline w-full text-center"
          >
            not in the wheel?
          </button>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What's going on? (optional)"
          rows={2}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />

        <button
          onClick={() => effectiveEmoji && onSubmit(effectiveEmoji, text)}
          disabled={!effectiveEmoji}
          className="w-full bg-indigo-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
        >
          Log check-in
        </button>
      </div>
    </div>
  );
}
