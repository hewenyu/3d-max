import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Layers, Plus, Trash2 } from 'lucide-react';
import type { MeshModifier } from '../../shared/modifier-schema';
import type { SceneObject } from '../../shared/types';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, VectorInput } from './Controls';
import './modifiers.css';

const names = { mirror: '镜像', array: '阵列', subdivision: '细分曲面' };
export function ModifierPanel({ object, editor }: { object: SceneObject; editor: EditorActions }) {
  const [kind, setKind] = useState<MeshModifier['type']>('array');
  if (
    object.vehicle ||
    object.effect ||
    (!object.modeling && !['box', 'sphere', 'cylinder', 'plane', 'wall'].includes(object.type))
  )
    return null;
  const modifiers = object.modeling?.kind === 'stack' ? object.modeling.modifiers : [];
  const set = (modifier: MeshModifier) => editor.run('modifier.set', { id: object.id, modifier });
  const add = () => {
    const common = { id: `modifier-${crypto.randomUUID()}`, enabled: true };
    const modifier: MeshModifier =
      kind === 'array'
        ? { ...common, type: 'array', count: 2, offset: [Math.max(object.dimensions[0], 0.1) * 1.5, 0, 0] }
        : kind === 'mirror'
          ? {
              ...common,
              type: 'mirror',
              axis: 'x',
              offset: Math.max(object.dimensions[0], 0.1) * 0.75,
              keepOriginal: true,
            }
          : { ...common, type: 'subdivision', iterations: 1, preserveEdges: false, flatOnly: false };
    editor.run('modifier.add', { id: object.id, modifier });
  };
  return (
    <div className="modifier-panel">
      <div className="modifier-heading">
        <Layers size={14} />
        <span>修改器</span>
        <span className="muted">{modifiers.length}</span>
      </div>
      <div className="modifier-add">
        <select
          aria-label="新增修改器类型"
          value={kind}
          onChange={(event) => setKind(event.target.value as MeshModifier['type'])}
        >
          {Object.entries(names).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <IconButton icon={Plus} label="添加修改器" disabled={modifiers.length >= 16} onClick={add} />
      </div>
      {modifiers.map((modifier, index) => (
        <div className="modifier-item" key={modifier.id}>
          <div className="modifier-heading">
            <input
              type="checkbox"
              aria-label={`启用修改器 ${index + 1}`}
              checked={modifier.enabled}
              onChange={(event) => set({ ...modifier, enabled: event.target.checked })}
            />
            <span>{names[modifier.type]}</span>
            <IconButton
              icon={ArrowUp}
              label={`上移修改器 ${index + 1}`}
              disabled={index === 0}
              onClick={() =>
                editor.run('modifier.reorder', { id: object.id, modifierId: modifier.id, index: index - 1 })
              }
            />
            <IconButton
              icon={ArrowDown}
              label={`下移修改器 ${index + 1}`}
              disabled={index === modifiers.length - 1}
              onClick={() =>
                editor.run('modifier.reorder', { id: object.id, modifierId: modifier.id, index: index + 1 })
              }
            />
            <IconButton
              icon={Trash2}
              label={`删除修改器 ${index + 1}`}
              onClick={() => editor.run('modifier.remove', { id: object.id, modifierId: modifier.id })}
            />
          </div>
          {modifier.type === 'mirror' && (
            <>
              <Field label="镜像轴">
                <select
                  aria-label={`修改器 ${index + 1} 镜像轴`}
                  value={modifier.axis}
                  onChange={(event) => set({ ...modifier, axis: event.target.value as 'x' | 'y' | 'z' })}
                >
                  <option value="x">X</option>
                  <option value="y">Y</option>
                  <option value="z">Z</option>
                </select>
              </Field>
              <Field label="镜面位置">
                <NumberInput
                  label={`修改器 ${index + 1} 镜面位置`}
                  value={modifier.offset}
                  min={-100000}
                  max={100000}
                  step={0.1}
                  suffix="m"
                  onChange={(offset) => set({ ...modifier, offset })}
                />
              </Field>
              <label className="row">
                <input
                  type="checkbox"
                  checked={modifier.keepOriginal}
                  onChange={(event) => set({ ...modifier, keepOriginal: event.target.checked })}
                />
                保留原几何
              </label>
            </>
          )}
          {modifier.type === 'array' && (
            <>
              <Field label="数量">
                <NumberInput
                  label={`修改器 ${index + 1} 数量`}
                  value={modifier.count}
                  min={2}
                  max={32}
                  step={1}
                  onChange={(count) => set({ ...modifier, count })}
                />
              </Field>
              <VectorInput
                label={`修改器 ${index + 1} 偏移`}
                value={modifier.offset}
                step={0.1}
                onChange={(offset) => set({ ...modifier, offset })}
              />
            </>
          )}
          {modifier.type === 'subdivision' && (
            <>
              <Field label="细分级别">
                <NumberInput
                  label={`修改器 ${index + 1} 细分级别`}
                  value={modifier.iterations}
                  min={1}
                  max={3}
                  step={1}
                  onChange={(iterations) => set({ ...modifier, iterations })}
                />
              </Field>
              <label className="row">
                <input
                  type="checkbox"
                  checked={modifier.preserveEdges}
                  onChange={(event) => set({ ...modifier, preserveEdges: event.target.checked })}
                />
                保持边界
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={modifier.flatOnly}
                  onChange={(event) => set({ ...modifier, flatOnly: event.target.checked })}
                />
                仅细分面片
              </label>
            </>
          )}
        </div>
      ))}
      {modifiers.length > 0 && (
        <button
          className="text-button full-width"
          onClick={() => editor.run('modifier.bake', { id: object.id })}
        >
          <Check size={14} />
          烘焙修改器
        </button>
      )}
    </div>
  );
}
