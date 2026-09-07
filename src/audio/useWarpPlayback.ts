import { useEffect, useMemo, useRef, useState } from 'react';
import { audioPlacements } from '../../shared/audio-plan';
import type { Project } from '../../shared/types';
import { decodeWarpAudio, scheduleWarpAudio } from './warp-audio';

export function useWarpPlayback(
  project: Project | null,
  time: number,
  duration: number,
  playing: boolean,
  muted: boolean,
  seekRevision: number,
): string {
  const [error, setError] = useState('');
  const placements = useMemo(
    () =>
      project
        ? audioPlacements(project, { includeAudio: true }, duration).filter((placement) => placement.warp)
        : [],
    [project, duration],
  );
  const context = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, Promise<AudioBuffer>>());
  const nodes = useRef<AudioBufferSourceNode[]>([]);
  const generation = useRef(0);
  const clock = useRef<{ project: Project; edit: number; context: number; seekRevision: number } | null>(
    null,
  );
  const loading = useRef(false);
  const latest = useRef({ time, playing, muted });
  latest.current = { time, playing, muted };
  const stop = () => {
    for (const node of nodes.current) {
      try {
        node.stop();
      } catch {
        /* Already stopped. */
      }
      node.disconnect();
    }
    nodes.current = [];
  };
  useEffect(() => {
    if (!project || !playing || muted || !placements.length) {
      generation.current++;
      stop();
      clock.current = null;
      loading.current = false;
      return;
    }
    const audio = (context.current ??= new AudioContext({ sampleRate: 48000 }));
    const current = clock.current;
    if (loading.current && current?.project === project && current.seekRevision === seekRevision) return;
    if (
      current?.project === project &&
      current.seekRevision === seekRevision &&
      Math.abs(current.edit + audio.currentTime - current.context - time) < 0.12
    )
      return;
    const ticket = ++generation.current;
    stop();
    loading.current = true;
    clock.current = { project, edit: time, context: audio.currentTime, seekRevision };
    void audio
      .resume()
      .then(() => decodeWarpAudio(audio, placements, buffers.current))
      .then((decoded) => {
        if (ticket !== generation.current || !latest.current.playing || latest.current.muted) return;
        const start = audio.currentTime + 0.01;
        nodes.current = scheduleWarpAudio(audio, decoded, placements, latest.current.time, start);
        clock.current = { project, edit: latest.current.time, context: start, seekRevision };
        loading.current = false;
        setError('');
      })
      .catch((failure) => {
        if (ticket === generation.current) {
          loading.current = false;
          setError((failure as Error).message);
        }
      });
  }, [project, placements, time, playing, muted, seekRevision]);
  useEffect(
    () => () => {
      generation.current++;
      stop();
      void context.current?.close();
    },
    [],
  );
  return error;
}
