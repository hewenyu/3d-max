import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { Euler, MathUtils, Vector3 } from 'three';
import type { SurfaceLoft } from '../../../shared/surfaces/schema';
import type { Vec3 } from '../../../shared/types';
import { Field, IconButton } from '../Controls';
import { SurfaceVectorInput } from './SurfaceCurveEditor';
import { SurfaceProfileEditor } from './SurfaceProfileEditor';

export function SurfaceLoftEditor({
  surface,
  onChange,
}: {
  surface: SurfaceLoft;
  onChange: (surface: SurfaceLoft) => void;
}) {
  const [selection, setSelection] = useState(0);
  const selected = Math.min(selection, surface.sections.length - 1);
  const section = surface.sections[selected];
  const patchSection = (patch: Partial<SurfaceLoft['sections'][number]>) =>
    onChange({
      ...surface,
      sections: surface.sections.map((item, index) => (index === selected ? { ...item, ...patch } : item)),
    });
  const move = (offset: number) => {
    const sections = [...surface.sections];
    [sections[selected], sections[selected + offset]] = [sections[selected + offset], sections[selected]];
    onChange({ ...surface, sections });
    setSelection(selected + offset);
  };
  const insert = (duplicate: boolean) => {
    const sections = structuredClone(surface.sections);
    const next = structuredClone(section);
    if (!duplicate) {
      const following = sections[selected + 1] ?? (surface.closed ? sections[0] : undefined);
      if (following) {
        next.position = next.position.map((value, axis) => (value + following.position[axis]) / 2) as Vec3;
        next.rotation = next.rotation.map((value, axis) => (value + following.rotation[axis]) / 2) as Vec3;
      } else {
        const offset = new Vector3(0, 0, 2).applyEuler(
          new Euler(...(next.rotation.map(MathUtils.degToRad) as Vec3), 'XYZ'),
        );
        next.position = new Vector3(...next.position).add(offset).toArray() as Vec3;
      }
    }
    sections.splice(selected + 1, 0, next);
    onChange({ ...surface, sections });
    setSelection(selected + 1);
  };
  return (
    <div className="surface-loft">
      <Field label="插值">
        <select
          aria-label="放样插值"
          value={surface.interpolation}
          onChange={(event) =>
            onChange({ ...surface, interpolation: event.target.value as SurfaceLoft['interpolation'] })
          }
        >
          <option value="centripetal">平滑</option>
          <option value="linear">线性</option>
        </select>
      </Field>
      <label className="surface-check">
        <input
          type="checkbox"
          aria-label="闭合放样"
          checked={surface.closed}
          onChange={(event) => onChange({ ...surface, closed: event.target.checked })}
        />
        闭合放样
      </label>
      <Field label="截面">
        <select
          aria-label="放样截面"
          value={selected}
          onChange={(event) => setSelection(Number(event.target.value))}
        >
          {surface.sections.map((_, index) => (
            <option value={index} key={index}>
              截面 {index + 1}
            </option>
          ))}
        </select>
      </Field>
      <div className="surface-section-tools">
        <IconButton
          icon={Plus}
          label="插入放样截面"
          disabled={surface.sections.length >= 64}
          onClick={() => insert(false)}
        />
        <IconButton
          icon={Copy}
          label="复制放样截面"
          disabled={surface.sections.length >= 64}
          onClick={() => insert(true)}
        />
        <IconButton icon={ArrowUp} label="前移放样截面" disabled={selected === 0} onClick={() => move(-1)} />
        <IconButton
          icon={ArrowDown}
          label="后移放样截面"
          disabled={selected === surface.sections.length - 1}
          onClick={() => move(1)}
        />
        <IconButton
          icon={Trash2}
          label="删除放样截面"
          disabled={surface.sections.length <= (surface.closed ? 3 : 2)}
          onClick={() => {
            onChange({ ...surface, sections: surface.sections.filter((_, index) => index !== selected) });
            setSelection(Math.max(0, selected - 1));
          }}
        />
      </div>
      <SurfaceVectorInput
        label="放样截面位置"
        value={section.position}
        onChange={(position) => patchSection({ position: position as Vec3 })}
      />
      <SurfaceVectorInput
        label="放样截面旋转"
        value={section.rotation}
        onChange={(rotation) => patchSection({ rotation: rotation as Vec3 })}
      />
      <SurfaceProfileEditor
        key={selected}
        profile={section.profile}
        onChange={(profile) => patchSection({ profile })}
      />
    </div>
  );
}
