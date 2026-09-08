import type { Vec3 } from '../../../shared/types';
import { Field } from '../Controls';
import { ModelingNumberInput } from './ModelingNumberInput';

export function TopologyVector({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: Vec3;
  onChange(value: Vec3): void;
  suffix?: string;
}) {
  return (
    <div className="topology-vector">
      <span>{label}</span>
      <div>
        {value.map((component, axis) => (
          <ModelingNumberInput
            key={axis}
            label={`${label} ${['X', 'Y', 'Z'][axis]}`}
            value={component}
            suffix={suffix}
            onChange={(next) => {
              const vector = [...value] as Vec3;
              vector[axis] = next;
              onChange(vector);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function TopologySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
}) {
  return (
    <Field label={label}>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TopologyCheck({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="topology-check">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
