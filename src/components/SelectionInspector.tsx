import { useState } from 'react';
import { AlignHorizontalSpaceAround, Copy, Group } from 'lucide-react';
import type { SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, NumberInput, Section } from './Controls';

export function SelectionInspector({
  objects,
  editor,
  onSelect,
}: {
  objects: SceneObject[];
  editor: EditorActions;
  onSelect: (ids: string[]) => void;
}) {
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('x');
  const [mode, setMode] = useState<'min' | 'center' | 'max' | 'value'>('center');
  const [value, setValue] = useState(0);
  const ids = objects.map((object) => object.id);
  const locked = objects.some((object) => object.locked);
  const siblings = objects.every(
    (object) =>
      object.parentId === objects[0].parentId &&
      !object.attachment &&
      !object.keyframes.some((frame) => frame.attachment),
  );
  const group = async () => {
    try {
      const result = await editor.command('object.group', { ids, name: '新编组' });
      const created = result?.results[0] as SceneObject | undefined;
      if (created) onSelect([created.id]);
    } catch {
      /* Editor reports validated command failures. */
    }
  };
  return (
    <>
      <Section title={`已选择 ${objects.length} 个对象`}>
        <div className="row">
          <button
            className="text-button"
            disabled={locked || !siblings || editor.busy}
            onClick={() => void group()}
          >
            <Group size={14} />
            编组
          </button>
          <button
            className="text-button"
            disabled={editor.busy}
            onClick={() => editor.run(ids.map((id) => ({ type: 'object.duplicate', payload: { id } })))}
          >
            <Copy size={14} />
            复制
          </button>
        </div>
      </Section>
      <Section title="原点对齐">
        <fieldset disabled={locked || !siblings || editor.busy}>
          <Field label="父级坐标轴">
            <select
              aria-label="对齐坐标轴"
              value={axis}
              onChange={(event) => setAxis(event.target.value as typeof axis)}
            >
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </Field>
          <Field label="对齐目标">
            <select
              aria-label="对齐目标"
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="min">最小位置</option>
              <option value="center">中心位置</option>
              <option value="max">最大位置</option>
              <option value="value">指定坐标</option>
            </select>
          </Field>
          {mode === 'value' && (
            <Field label="目标坐标">
              <NumberInput label="对齐目标坐标" value={value} onChange={setValue} suffix="m" />
            </Field>
          )}
          <button
            className="text-button"
            onClick={() =>
              editor.run('object.align', { ids, axis, ...(mode === 'value' ? { value } : { mode }) })
            }
          >
            <AlignHorizontalSpaceAround size={14} />
            对齐原点
          </button>
        </fieldset>
      </Section>
    </>
  );
}
