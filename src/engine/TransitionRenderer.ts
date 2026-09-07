import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

type Frame = { x: number; y: number; width: number; height: number };

/** Mix the same final display pixels used by normal rendering, including camera optics. */
export class TransitionRenderer {
  private textures: THREE.FramebufferTexture[] = [];
  private width = 0;
  private height = 0;
  private readonly material = new THREE.ShaderMaterial({
    uniforms: {
      outgoing: { value: null },
      incoming: { value: null },
      progress: { value: 0 },
      opacity: { value: 1 },
    },
    vertexShader:
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform sampler2D outgoing; uniform sampler2D incoming; uniform float progress; uniform float opacity; varying vec2 vUv; void main() { gl_FragColor = vec4(mix(texture2D(outgoing, vUv).rgb, texture2D(incoming, vUv).rgb, progress) * opacity, 1.0); }',
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly quad = new FullScreenQuad(this.material);

  render(
    renderer: THREE.WebGLRenderer,
    frame: Frame,
    first: () => void,
    second?: () => void,
    progress = 0,
    opacity = 1,
  ) {
    const ratio = renderer.getPixelRatio();
    const width = Math.max(1, Math.floor(frame.width * ratio));
    const height = Math.max(1, Math.floor(frame.height * ratio));
    if (width !== this.width || height !== this.height) {
      this.textures.forEach((texture) => texture.dispose());
      this.textures = [
        new THREE.FramebufferTexture(width, height),
        new THREE.FramebufferTexture(width, height),
      ];
      this.width = width;
      this.height = height;
    }
    const position = new THREE.Vector2(Math.floor(frame.x * ratio), Math.floor(frame.y * ratio));
    first();
    renderer.copyFramebufferToTexture(this.textures[0], position);
    if (second) {
      second();
      renderer.copyFramebufferToTexture(this.textures[1], position);
    }
    this.material.uniforms.outgoing.value = this.textures[0];
    this.material.uniforms.incoming.value = this.textures[second ? 1 : 0];
    this.material.uniforms.progress.value = progress;
    this.material.uniforms.opacity.value = opacity;
    renderer.setRenderTarget(null);
    renderer.setViewport(frame.x, frame.y, frame.width, frame.height);
    renderer.setScissor(frame.x, frame.y, frame.width, frame.height);
    renderer.setScissorTest(true);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
    renderer.setScissorTest(false);
  }

  dispose() {
    this.textures.forEach((texture) => texture.dispose());
    this.material.dispose();
    this.quad.dispose();
  }
}
