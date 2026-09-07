export class PlaybackGainMixer {
  private context?: AudioContext;
  private nodes = new Map<HTMLAudioElement, { source: MediaElementAudioSourceNode; gain: GainNode }>();

  connect(element: HTMLAudioElement) {
    if (this.nodes.has(element)) return;
    const context = (this.context ??= new AudioContext());
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(context.destination);
    this.nodes.set(element, { source, gain });
  }

  setGain(element: HTMLAudioElement, value: number) {
    const node = this.nodes.get(element);
    if (!node || !this.context) return;
    element.volume = 1;
    const now = this.context.currentTime;
    node.gain.gain.cancelScheduledValues(now);
    node.gain.gain.setTargetAtTime(value, now, 0.005);
  }

  resume() {
    return this.context?.resume() ?? Promise.resolve();
  }

  release(element: HTMLAudioElement) {
    const node = this.nodes.get(element);
    node?.source.disconnect();
    node?.gain.disconnect();
    this.nodes.delete(element);
  }

  dispose() {
    for (const element of this.nodes.keys()) this.release(element);
    void this.context?.close();
    this.context = undefined;
  }
}
