import { vehicleSchema, type VehicleSettings } from '../../shared/motion';
import type { SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, NumberInput } from './Controls';

export function VehiclePanel({ object, editor }: { object: SceneObject; editor: EditorActions }) {
  if (!object.vehicle) return null;
  const update = (patch: Partial<VehicleSettings>) =>
    editor.run((latest) => {
      const target = latest.objects.find((item) => item.id === object.id);
      if (!target?.vehicle) throw new Error('载具已删除');
      return [
        {
          type: 'vehicle.configure',
          payload: { id: object.id, vehicle: vehicleSchema.parse({ ...target.vehicle, ...patch }) },
        },
      ];
    });
  return (
    <fieldset disabled={object.locked || editor.busy} className="motion-fields">
      <Field label="载具类型">
        <select
          aria-label="载具类型"
          value={object.vehicle.kind}
          onChange={(event) => update({ kind: event.target.value as VehicleSettings['kind'] })}
        >
          <option value="car">汽车</option>
          <option value="spacecraft">飞行器</option>
        </select>
      </Field>
      {object.vehicle.kind === 'car' && (
        <>
          <Field label="轮胎半径">
            <NumberInput
              label="轮胎半径"
              value={object.vehicle.wheelRadius}
              min={0.05}
              max={10}
              onChange={(wheelRadius) => update({ wheelRadius })}
              suffix="m"
            />
          </Field>
          <Field label="轴距">
            <NumberInput
              label="车辆轴距"
              value={object.vehicle.wheelBase}
              min={0.2}
              max={50}
              onChange={(wheelBase) => update({ wheelBase })}
              suffix="m"
            />
          </Field>
          <Field label="轮距">
            <NumberInput
              label="车辆轮距"
              value={object.vehicle.trackWidth}
              min={0.2}
              max={30}
              onChange={(trackWidth) => update({ trackWidth })}
              suffix="m"
            />
          </Field>
          <Field label="最大转向">
            <NumberInput
              label="最大转向角"
              value={object.vehicle.maxSteer}
              min={0}
              max={80}
              onChange={(maxSteer) => update({ maxSteer })}
            />
          </Field>
          <Field label="车身侧倾">
            <NumberInput
              label="车身侧倾系数"
              value={object.vehicle.bodyRoll}
              min={0}
              max={2}
              onChange={(bodyRoll) => update({ bodyRoll })}
            />
          </Field>
        </>
      )}
    </fieldset>
  );
}
