import * as THREE from 'three';
import { quaternionFor, vehicleSchema, type MotionObject } from '../../shared/motion';
import { sampleObject } from '../../shared/timeline';
import type { SceneObject } from '../../shared/types';

export class VehicleRig {
  readonly root = new THREE.Group();
  private readonly chassis = new THREE.Group();
  private readonly wheels: { steering: THREE.Group; spin: THREE.Group; front: boolean }[] = [];

  constructor(input: SceneObject) {
    const object = input as MotionObject;
    const config = vehicleSchema.parse(object.vehicle);
    const [width, height, length] = object.dimensions;
    const white = new THREE.MeshStandardMaterial({ color: object.tone, roughness: 0.8 });
    const gray = new THREE.MeshStandardMaterial({ color: '#929896', roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: '#555e5a', roughness: 0.9 });
    const window = new THREE.MeshStandardMaterial({
      color: '#b7c5c2',
      roughness: 0.35,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const mesh = (
      geometry: THREE.BufferGeometry,
      position: [number, number, number],
      material: THREE.Material = white,
      parent: THREE.Object3D = this.chassis,
    ) => {
      const value = new THREE.Mesh(geometry, material);
      value.position.set(...position);
      value.castShadow = true;
      value.receiveShadow = true;
      parent.add(value);
      return value;
    };
    const box = (
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material = white,
    ) => mesh(new THREE.BoxGeometry(...size), position, material);
    this.root.add(this.chassis);
    if (config.kind === 'spacecraft') {
      box([width * 0.24, height * 0.48, length * 0.75], [0, height * 0.5, -length * 0.08]);
      const nose = mesh(new THREE.ConeGeometry(width * 0.12, length * 0.4, 4), [
        0,
        height * 0.5,
        length * 0.4,
      ]);
      nose.rotation.x = Math.PI / 2;
      for (const side of [-1, 1]) {
        const wing = box(
          [width * 0.45, height * 0.09, length * 0.3],
          [side * width * 0.28, height * 0.38, -length * 0.16],
        );
        wing.rotation.y = (side * Math.PI) / 9;
        const engine = mesh(
          new THREE.CylinderGeometry(height * 0.19, height * 0.25, length * 0.35, 12),
          [side * width * 0.18, height * 0.5, -length * 0.4],
          gray,
        );
        engine.rotation.x = Math.PI / 2;
        box(
          [width * 0.025, height * 0.55, length * 0.18],
          [side * width * 0.11, height * 0.74, -length * 0.31],
        );
      }
      const cockpit = mesh(new THREE.SphereGeometry(1, 16, 12), [0, height * 0.72, length * 0.14], dark);
      cockpit.scale.set(width * 0.1, height * 0.22, length * 0.2);
      return;
    }
    const radius = config.wheelRadius;
    box([width, height * 0.27, length], [0, radius + height * 0.13, 0]);
    box([width * 0.83, height * 0.07, length * 0.46], [0, height * 0.95, -length * 0.06]);
    box([width * 0.86, height * 0.38, length * 0.012], [0, height * 0.72, length * 0.175], window);
    box([width * 0.86, height * 0.38, length * 0.012], [0, height * 0.72, -length * 0.3], window);
    for (const side of [-1, 1]) {
      for (const front of [-1, 1])
        box(
          [width * 0.035, height * 0.45, length * 0.027],
          [side * width * 0.425, height * 0.72, front > 0 ? length * 0.18 : -length * 0.3],
        );
      box(
        [width * 0.025, height * 0.035, length * 0.49],
        [side * width * 0.435, height * 0.52, -length * 0.06],
      );
      box(
        [width * 0.31, height * 0.09, length * 0.17],
        [side * width * 0.22, height * 0.4, -length * 0.015],
        gray,
      );
      box(
        [width * 0.31, height * 0.34, length * 0.045],
        [side * width * 0.22, height * 0.57, -length * 0.11],
        gray,
      );
      box(
        [width * 0.18, height * 0.08, length * 0.025],
        [side * width * 0.32, radius + height * 0.18, length * 0.51],
        gray,
      );
      for (const front of [false, true]) {
        const steering = new THREE.Group();
        steering.position.set(
          (side * config.trackWidth) / 2,
          radius,
          ((front ? 1 : -1) * config.wheelBase) / 2,
        );
        const spin = new THREE.Group();
        steering.add(spin);
        this.root.add(steering);
        const tire = mesh(
          new THREE.CylinderGeometry(radius, radius, width * 0.13, 24),
          [0, 0, 0],
          dark,
          spin,
        );
        tire.rotation.z = Math.PI / 2;
        const hub = mesh(
          new THREE.CylinderGeometry(radius * 0.65, radius * 0.65, width * 0.135, 16),
          [0, 0, 0],
          gray,
          spin,
        );
        hub.rotation.z = Math.PI / 2;
        for (const angle of [0, Math.PI / 2]) {
          const spoke = mesh(
            new THREE.BoxGeometry(width * 0.14, radius * 1.1, radius * 0.11),
            [0, 0, 0],
            white,
            spin,
          );
          spoke.rotation.x = angle;
        }
        this.wheels.push({ steering, spin, front });
      }
    }
    box([width * 0.8, height * 0.12, length * 0.09], [0, height * 0.54, length * 0.15], gray);
    const steeringWheel = mesh(
      new THREE.TorusGeometry(width * 0.085, width * 0.01, 8, 24),
      [-width * 0.22, height * 0.62, length * 0.085],
      dark,
    );
    steeringWheel.rotation.x = -Math.PI / 5;
  }

  update(input: SceneObject, time: number, distance: number): void {
    const object = input as MotionObject;
    if (object.vehicle?.kind !== 'car') return;
    const config = object.vehicle;
    const delta = 0.08;
    const before = sampleObject(object, Math.max(0, time - delta), { render: true });
    const after = sampleObject(object, time + delta, { render: true });
    const speed =
      new THREE.Vector3(...after.position).distanceTo(new THREE.Vector3(...before.position)) /
      (time < delta ? time + delta : delta * 2);
    const turn = quaternionFor(before.rotation).invert().multiply(quaternionFor(after.rotation));
    if (turn.w < 0) turn.set(-turn.x, -turn.y, -turn.z, -turn.w);
    const yaw = 2 * Math.atan2(turn.y, turn.w);
    const curvature = speed > 0.02 ? yaw / Math.max(1e-8, speed * delta * 2) : 0;
    const steer = THREE.MathUtils.clamp(
      Math.atan(config.wheelBase * curvature),
      -THREE.MathUtils.degToRad(config.maxSteer),
      THREE.MathUtils.degToRad(config.maxSteer),
    );
    for (const wheel of this.wheels) {
      wheel.steering.rotation.y = wheel.front ? steer : 0;
      wheel.spin.rotation.x = distance / config.wheelRadius;
    }
    this.chassis.rotation.z = -steer * config.bodyRoll * Math.min(1, speed / 15);
  }
}
