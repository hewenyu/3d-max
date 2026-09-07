import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { CameraOptics } from '../../shared/camera-optics';

/** Three's bokeh sampler, with a thin-lens circle of confusion in scene meters. */
export class CameraOpticsRenderer {
  private readonly color = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  private readonly blurred = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private readonly bokeh: BokehPass;
  private readonly output = new OutputPass();
  private width = 0;
  private height = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    this.bokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0, maxblur: 0.12 });
    this.bokeh.materialBokeh.fragmentShader = this.bokeh.materialBokeh.fragmentShader.replace(
      'float factor = ( focus + viewZ );',
      'float factor = ( focus + viewZ ) / max( -viewZ, 0.0001 );',
    );
    this.output.renderToScreen = true;
  }

  render(
    renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
    optics: CameraOptics,
    focusDistance: number,
  ) {
    const pixelRatio = renderer.getPixelRatio();
    const physicalWidth = Math.max(1, Math.round(width * pixelRatio));
    const physicalHeight = Math.max(1, Math.round(height * pixelRatio));
    if (this.width !== physicalWidth || this.height !== physicalHeight) {
      this.width = physicalWidth;
      this.height = physicalHeight;
      this.color.setSize(physicalWidth, physicalHeight);
      this.blurred.setSize(physicalWidth, physicalHeight);
      this.bokeh.setSize(physicalWidth, physicalHeight);
    }
    const sensorWidth = optics.sensorWidthMm / 1000;
    const focalLength =
      sensorWidth / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    const focus = Math.max(this.camera.near, focusDistance);
    const aperture =
      (1.25 * focalLength * focalLength) /
      (optics.fStop * Math.max(0.001, focus - focalLength) * sensorWidth);
    const uniforms = this.bokeh.materialBokeh.uniforms;
    uniforms.focus.value = focus;
    uniforms.aperture.value = aperture;
    renderer.setScissorTest(false);
    renderer.setRenderTarget(this.color);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.bokeh.render(renderer, this.blurred, this.color, 0, false);
    this.output.render(renderer, this.color, this.blurred, 0, false);
    renderer.setRenderTarget(null);
  }

  dispose() {
    this.color.dispose();
    this.blurred.dispose();
    this.bokeh.dispose();
    this.output.dispose();
  }
}
