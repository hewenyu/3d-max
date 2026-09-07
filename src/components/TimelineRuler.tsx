import { useLayoutEffect, useRef, useState, type PointerEventHandler } from 'react';

interface RulerTick {
  time: number;
  label: string;
  percent: number;
  terminal: boolean;
}

const seconds = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 3 });

export function timelineRulerTicks(duration: number, width: number, measure: (label: string) => number) {
  const ticks: RulerTick[] = [{ time: 0, label: '0s', percent: 0, terminal: false }];
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0) return ticks;
  const endLabel = `${seconds.format(duration)}s`;
  const gap = 10;
  const endLeft = width - measure(endLabel);
  let previousRight = measure('0s');
  if (endLeft < previousRight + gap) return ticks;
  const desiredStep = Math.max(0.001, (duration * Math.max(56, measure(endLabel) + gap)) / width);
  const magnitude = 10 ** Math.floor(Math.log10(desiredStep));
  const step = [1, 2, 5, 10].find((value) => value * magnitude >= desiredStep)! * magnitude;
  for (let index = 1; index * step < duration; index++) {
    const time = index * step;
    const left = (time / duration) * width;
    const label = `${seconds.format(time)}s`;
    const right = left + measure(label);
    if (left < previousRight + gap || right + gap > endLeft) continue;
    ticks.push({ time, label, percent: (time / duration) * 100, terminal: false });
    previousRight = right;
  }
  ticks.push({ time: duration, label: endLabel, percent: 100, terminal: true });
  return ticks;
}

export function TimelineRuler({
  duration,
  onScrub,
}: {
  duration: number;
  onScrub: PointerEventHandler<HTMLDivElement>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [ticks, setTicks] = useState<RulerTick[]>([]);
  useLayoutEffect(() => {
    const ruler = element.current!;
    const context = document.createElement('canvas').getContext('2d')!;
    const update = () => {
      context.font = getComputedStyle(ruler).font;
      setTicks(
        timelineRulerTicks(duration, ruler.clientWidth, (label) => context.measureText(label).width + 7),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, [duration]);
  return (
    <div
      ref={element}
      className="timeline-ruler"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        onScrub(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) onScrub(event);
      }}
    >
      {ticks.map((tick) => (
        <span
          key={tick.time}
          data-time={tick.time}
          className={tick.terminal ? 'ruler-end' : undefined}
          style={{ left: `${tick.percent}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
