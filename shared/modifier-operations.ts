import { ModelingError, modifierStackSchema, type ModelingData, type ModifierStack } from './modeling';
import { modelingToMesh, primitiveToMesh } from './modeling-geometry';
import { meshModifierSchema } from './modifier-schema';
import type { Command, SceneObject } from './types';

export function modifyStack(object: SceneObject, command: Command): ModelingData {
  if (object.vehicle || object.effect)
    throw new ModelingError('Modifiers require mesh geometry, not a vehicle or effect rig');
  const payload = command.payload;
  if (command.type === 'modifier.bake') {
    if (object.modeling?.kind !== 'stack') throw new ModelingError('The object has no modifier stack');
    return modelingToMesh(object.modeling);
  }
  let stack: ModifierStack;
  if (object.modeling?.kind === 'stack') stack = structuredClone(object.modeling);
  else {
    if (command.type !== 'modifier.add') throw new ModelingError('The object has no modifier stack');
    stack = { kind: 'stack', base: object.modeling ?? primitiveToMesh(object), modifiers: [] };
  }
  if (command.type === 'modifier.add') {
    const modifier = meshModifierSchema.parse(payload.modifier);
    if (stack.modifiers.some((current) => current.id === modifier.id))
      throw new ModelingError('Modifier ID already exists', 'CONFLICT', 409);
    const index = payload.index === undefined ? stack.modifiers.length : (payload.index as number);
    if (index > stack.modifiers.length) throw new ModelingError('Modifier index is out of range');
    stack.modifiers.splice(index, 0, modifier);
  } else {
    const modifier = command.type === 'modifier.set' ? meshModifierSchema.parse(payload.modifier) : null;
    const id = modifier?.id ?? payload.modifierId;
    const index = stack.modifiers.findIndex((current) => current.id === id);
    if (index < 0) throw new ModelingError('Modifier does not exist', 'NOT_FOUND', 404);
    if (modifier) stack.modifiers[index] = modifier;
    else if (command.type === 'modifier.remove') stack.modifiers.splice(index, 1);
    else if (command.type === 'modifier.reorder') {
      const destination = payload.index as number;
      if (destination >= stack.modifiers.length) throw new ModelingError('Modifier index is out of range');
      const [moving] = stack.modifiers.splice(index, 1);
      stack.modifiers.splice(destination, 0, moving);
    } else throw new ModelingError(`Unknown modifier command: ${command.type}`);
  }
  return stack.modifiers.length ? modifierStackSchema.parse(stack) : stack.base;
}
