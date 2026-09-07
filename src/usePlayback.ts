import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import { sampleTimeline, sequenceDuration } from '../shared/timeline';
import { resolveShotProject } from '../shared/production';
import { useWarpPlayback } from './audio/useWarpPlayback';
import { audioGain } from '../shared/audio-envelope';
import { PlaybackGainMixer } from './audio/PlaybackGainMixer';

export function usePlayback(project: Project | null) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [seekRevision, setSeekRevision] = useState(0);
  const audioElements = useRef(new Map<string, HTMLAudioElement>());
  const audioUrls = useRef(new Map<string, string>());
  const gainMixer = useRef<PlaybackGainMixer | null>(null);
  const [gainError, setGainError] = useState('');
  const previousClock = useRef<{
    sequence: number;
    source: number;
    rate: number;
    seekRevision: number;
    clipId?: string;
  } | null>(null);
  const cursor = useRef(0);
  cursor.current = time;
  const duration = project ? sequenceDuration(project) : 0;
  const shotId = project ? sampleTimeline(project, time).shot?.id : undefined;
  const performanceProject = useMemo(
    () =>
      project ? resolveShotProject(project, project.shots.find((shot) => shot.id === shotId) ?? null) : null,
    [project, shotId],
  );
  const audioError = useWarpPlayback(project, time, duration, playing, muted, seekRevision);
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
    const tracks = performanceProject?.audio ?? project.audio;
    const mixer = (gainMixer.current ??= new PlaybackGainMixer());
    const active = new Set(tracks.map((a) => a.id));
    const timeline = sampleTimeline(project, time);
    const previous = previousClock.current;
    const explicitSeek = previous?.seekRevision !== seekRevision;
    const sourceJump =
      previous !== null &&
      (previous.clipId !== timeline.clip?.id ||
        Math.abs(timeline.sourceTime - previous.source - (time - previous.sequence) * previous.rate) >
          1 / project.settings.fps);
    previousClock.current = {
      sequence: time,
      source: timeline.sourceTime,
      rate: timeline.playbackRate,
      seekRevision,
      clipId: timeline.clip?.id,
    };
    for (const [id, audio] of audioElements.current)
      if (!active.has(id)) {
        audio.pause();
        mixer.release(audio);
        audioElements.current.delete(id);
        audioUrls.current.delete(id);
      }
    for (const clip of tracks) {
      let audio = audioElements.current.get(clip.id);
      if (!audio || audioUrls.current.get(clip.id) !== clip.url) {
        audio?.pause();
        if (audio) mixer.release(audio);
        audio = new Audio(clip.url);
        audio.preload = 'auto';
        audioElements.current.set(clip.id, audio);
        audioUrls.current.set(clip.id, clip.url);
        mixer.connect(audio);
      }
      const referenceTime = clip.sync === 'source' ? timeline.sourceTime : time;
      const localTime = referenceTime - clip.start;
      const shouldPlay =
        playing &&
        !muted &&
        !clip.muted &&
        !(clip.sync === 'source' && (timeline.audioMuted || timeline.clip?.retiming?.audio === 'warp')) &&
        localTime >= 0 &&
        localTime < clip.duration;
      mixer.setGain(audio, audioGain(clip, localTime));
      audio.playbackRate = clip.sync === 'source' ? timeline.playbackRate : 1;
      audio.preservesPitch = true;
      if (shouldPlay) {
        if (
          explicitSeek ||
          (clip.sync === 'source' && sourceJump) ||
          Math.abs(audio.currentTime - (localTime + clip.sourceIn)) > 0.08
        )
          audio.currentTime = Math.max(0, localTime + clip.sourceIn);
        if (audio.paused) void audio.play().catch(() => undefined);
      } else audio.pause();
    }
    if (playing && !muted) void mixer.resume().catch((error: Error) => setGainError(error.message));
  }, [project, performanceProject, time, playing, muted, seekRevision]);
  useEffect(
    () => () => {
      for (const audio of audioElements.current.values()) audio.pause();
      gainMixer.current?.dispose();
      audioElements.current.clear();
      audioUrls.current.clear();
      gainMixer.current = null;
    },
    [],
  );
  const seek = (next: number) => {
    const value = Math.max(0, Math.min(duration, next));
    cursor.current = value;
    setTime(value);
    setSeekRevision((revision) => revision + 1);
  };
  const toggle = () => {
    if (!playing && time >= duration) seek(0);
    setPlaying((p) => !p);
  };
  return {
    time,
    seek,
    playing,
    setPlaying,
    toggle,
    loop,
    setLoop,
    muted,
    setMuted,
    duration,
    audioError: audioError || gainError,
  };
}

export type Playback = ReturnType<typeof usePlayback>;
