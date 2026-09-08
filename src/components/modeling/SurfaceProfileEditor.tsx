import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { SurfaceCurve2, SurfaceProfile } from '../../../shared/surfaces/schema';
import { Field, IconButton } from '../Controls';
import { SurfaceCurveEditor } from './SurfaceCurveEditor';
import { profilePreset } from './surface-presets';

export function SurfaceProfileEditor({
  profile,
  onChange,
}: {
  profile: SurfaceProfile;
  onChange: (profile: SurfaceProfile) => void;
}) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, profile.holes.length);
  const curve = index === 0 ? profile.outer : profile.holes[index - 1];
  const update = (next: SurfaceCurve2) =>
    onChange(
      index === 0
        ? { ...profile, outer: next }
        : { ...profile, holes: profile.holes.map((hole, i) => (i === index - 1 ? next : hole)) },
    );
  const addHole = () => {
    const points = profile.outer.points.map((point) => point.position);
    const minimum = [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
    ];
    const maximum = [
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ];
    const size = Math.min(maximum[0] - minimum[0], maximum[1] - minimum[1]) / 8;
    const hole = profilePreset('rectangle', Math.max(0.001, size));
    hole.points = hole.points.map((point) => ({
      ...point,
      position: [
        point.position[0] + (minimum[0] + maximum[0]) / 2,
        point.position[1] + (minimum[1] + maximum[1]) / 2,
      ],
    }));
    onChange({ ...profile, holes: [...profile.holes, hole] });
    setSelected(profile.holes.length + 1);
  };
  return (
    <div className="surface-profile">
      <div className="surface-inline">
        <Field label="轮廓">
          <select
            aria-label="曲面截面轮廓"
            value={index}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            <option value={0}>外轮廓</option>
            {profile.holes.map((_, i) => (
              <option value={i + 1} key={i}>
                孔洞 {i + 1}
              </option>
            ))}
          </select>
        </Field>
        <IconButton
          icon={Plus}
          label="添加截面孔洞"
          disabled={profile.holes.length >= 16}
          onClick={addHole}
        />
        <IconButton
          icon={Trash2}
          label="删除截面孔洞"
          disabled={index === 0}
          onClick={() => {
            onChange({ ...profile, holes: profile.holes.filter((_, i) => i !== index - 1) });
            setSelected(0);
          }}
        />
      </div>
      <SurfaceCurveEditor
        key={index}
        label={index === 0 ? '外轮廓' : `孔洞 ${index}`}
        dimensions={2}
        curve={curve}
        fixedClosed
        onChange={(next) => update(next as SurfaceCurve2)}
      />
    </div>
  );
}
