import { useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import { sampleTimeline, sequenceDuration } from '../shared/timeline';

export function usePlayback(project: Project | null) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioElements = useRef(new Map<string, HTMLAudioElement>());
  const audioUrls = useRef(new Map<string, string>());
  const previousClock = useRef<{ sequence: number; source: number } | null>(null);
  const cursor = useRef(0);
  cursor.current = time;
  const duration = project ? sequenceDuration(project) : 0;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      let next = cursor.current + Math.min((now - last) / 1000, 0.25);
      last = now;
      if (next >= duration) {
        next = loop ? 0 : duration;
        if (!loop) setPlaying(false);
      }
      cursor.current = next;
      setTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, loop]);
  useEffect(() => {
    if (time > duration) setTime(duration);
  }, [duration, time]);
  useEffect(() => {
    if (!project) return;
    const active = new Set(project.audio.map((a) => a.id));
    const timeline = sampleTimeline(project, time);
    const previous = previousClock.current;
    const sourceJump =
      previous !== null &&
      Math.abs(timeline.sourceTime - previous.source - (time - previous.sequence)) > 1 / project.settings.fps;
    previousClock.current = { sequence: time, source: timeline.sourceTime };
    for (const [id, audio] of audioElements.current)
      if (!active.has(id)) {
        audio.pause();
        audioElements.current.delete(id);
        audioUrls.current.delete(id);
      }
    for (const clip of project.audio) {
      let audio = audioElements.current.get(clip.id);
      if (!audio || audioUrls.current.get(clip.id) !== clip.url) {
        audio?.pause();
        audio = new Audio(clip.url);
        audio.preload = 'auto';
        audioElements.current.set(clip.id, audio);
        audioUrls.current.set(clip.id, clip.url);
      }
      const referenceTime = clip.sync === 'source' ? timeline.sourceTime : time;
      const localTime = referenceTime - clip.start;
      const shouldPlay = playing && !muted && !clip.muted && localTime >= 0 && localTime < clip.duration;
      audio.volume = Math.max(0, Math.min(1, clip.volume));
      if (shouldPlay) {
        if (
          (clip.sync === 'source' && sourceJump) ||
          Math.abs(audio.currentTime - (localTime + clip.sourceIn)) > 0.08
        )
          audio.currentTime = Math.max(0, localTime + clip.sourceIn);
        if (audio.paused) void audio.play().catch(() => undefined);
      } else audio.pause();
    }
  }, [project, time, playing, muted]);
  useEffect(
    () => () => {
      for (const audio of audioElements.current.values()) audio.pause();
    },
    [],
  );
  const seek = (next: number) => {
    const value = Math.max(0, Math.min(duration, next));
    cursor.current = value;
    setTime(value);
  };
  const toggle = () => {
    if (!playing && time >= duration) seek(0);
    setPlaying((p) => !p);
  };
  return { time, seek, playing, setPlaying, toggle, loop, setLoop, muted, setMuted, duration };
}

export type Playback = ReturnType<typeof usePlayback>;
