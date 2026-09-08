import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Copy, Layers, Plus, Trash2 } from 'lucide-react';
import type { MeshModifier } from '../../shared/modifier-schema';
import type { Project, SceneObject } from '../../shared/types';
import { supportsMeshConversion } from '../../shared/modeling';
import type { EditorActions } from '../useEditor';
import { Field, IconButton } from './Controls';
import { ModifierParameters } from './modeling/ModifierParameters';
import { defaultModifier, modifierNames } from './modeling/modifier-defaults';
import './modifiers.css';

export function ModifierPanel({
  object,
  editor,
  project,
}: {
  object: SceneObject;
  editor: EditorActions;
  project: Project;
}) {
  const [kind, setKind] = useState<MeshModifier['type']>('array');
  const [operandId, setOperandId] = useState('');
  if (
    object.vehicle ||
    object.effect ||
    (!object.modeling && !['box', 'sphere', 'cylinder', 'plane', 'wall'].includes(object.type))
  )
    return null;
  const modifiers = object.modeling?.kind === 'stack' ? object.modeling.modifiers : [];
  const operands = project.objects.filter(
    (candidate) =>
      candidate.id !== object.id &&
      !candidate.vehicle &&
      !candidate.effect &&
      !candidate.attachment &&
      supportsMeshConversion(candidate),
  );
  const chosenOperand = operands.some((candidate) => candidate.id === operandId)
    ? operandId
    : operands[0]?.id;
  const set = (modifier: MeshModifier) => editor.run('modifier.set', { id: object.id, modifier });
  const add = () => {
    editor.run('modifier.add', {
      id: object.id,
      modifier: defaultModifier(kind, object.dimensions, chosenOperand),
    });
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
          {Object.entries(modifierNames).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <IconButton
          icon={Plus}
          label="添加修改器"
          disabled={modifiers.length >= 16 || (kind === 'boolean' && !chosenOperand)}
          onClick={add}
        />
      </div>
      {kind === 'boolean' && (
        <Field label="布尔操作数">
          <select
            aria-label="新增布尔修改器操作数"
            value={chosenOperand ?? ''}
            onChange={(event) => setOperandId(event.target.value)}
          >
            {!operands.length && <option value="">无可用对象</option>}
            {operands.map((operand) => (
              <option key={operand.id} value={operand.id}>
                {operand.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {modifiers.map((modifier, index) => (
        <div className="modifier-item" key={modifier.id}>
          <div className="modifier-heading">
            <input
              type="checkbox"
              aria-label={`启用修改器 ${index + 1}`}
              checked={modifier.enabled}
              onChange={(event) => set({ ...modifier, enabled: event.target.checked })}
            />
            <span>{modifierNames[modifier.type]}</span>
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
              icon={Copy}
              label={`复制修改器 ${index + 1}`}
              disabled={modifiers.length >= 16}
              onClick={() =>
                editor.run('modifier.add', {
                  id: object.id,
                  modifier: { ...structuredClone(modifier), id: `modifier-${crypto.randomUUID()}` },
                  index: index + 1,
                })
              }
            />
            <IconButton
              icon={Trash2}
              label={`删除修改器 ${index + 1}`}
              onClick={() => editor.run('modifier.remove', { id: object.id, modifierId: modifier.id })}
            />
          </div>
          <ModifierParameters modifier={modifier} index={index} onChange={set} operands={operands} />
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
