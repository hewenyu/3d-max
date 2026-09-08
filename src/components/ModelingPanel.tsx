import { useState } from 'react';
import { ArrowUpFromLine, Box, Combine, Mountain, Paintbrush, Plus, Route, Trash2 } from 'lucide-react';
import type { Project, SceneObject, Vec3 } from '../../shared/types';
import type { CurveData, MeshData, ModelingData, TerrainData } from '../../shared/modeling';
import { supportsMeshConversion } from '../../shared/modeling';
import type { EditorActions } from '../useEditor';
import { Field, IconButton, NumberInput, Section, TextInput, VectorInput } from './Controls';
import { ModifierPanel } from './ModifierPanel';
import { SurfacePanel } from './modeling/SurfacePanel';
import { defaultSurface } from './modeling/surface-presets';
import { TopologyPanel } from './modeling/TopologyPanel';
import { ModelAssetsPanel } from './modeling/ModelAssetsPanel';

interface Props {
  object: SceneObject;
  project: Project;
  editor: EditorActions;
  sourceTime?: number;
}
function parameters(curve: CurveData) {
  return {
    points: curve.points,
    closed: curve.closed,
    segments: curve.segments,
    profile: curve.profile,
    width: curve.width,
    radius: curve.radius,
    thickness: curve.thickness,
    bank: curve.bank,
    radialSegments: curve.radialSegments,
  };
}
function latestModel(project: Project, id: string): ModelingData {
  const modeling = project.objects.find((object) => object.id === id)?.modeling;
  if (!modeling) throw new Error('建模对象已变化，请重新选择');
  return modeling.kind === 'stack' ? modeling.base : modeling;
}

function MeshControls({
  object,
  mesh,
  editor,
}: {
  object: SceneObject;
  mesh: MeshData;
  editor: EditorActions;
}) {
  const [selectedVertex, setSelectedVertex] = useState(0);
  const [selectedFace, setSelectedFace] = useState(0);
  const [distance, setDistance] = useState(0.5);
  const [faceIndices, setFaceIndices] = useState('[0, 1, 2]');
  const [newVertex, setNewVertex] = useState<Vec3>([0, 0, 0]);
  const vertex = Math.min(selectedVertex, mesh.vertices.length - 1);
  const face = Math.min(selectedFace, mesh.faces.length - 1);
  const setVertexAxis = (axis: number, value: number) =>
    editor.run((latest) => {
      const current = latestModel(latest, object.id);
      if (current.kind !== 'mesh' || !current.vertices[vertex]) throw new Error('网格顶点已变化，请重新选择');
      const position = [...current.vertices[vertex]] as Vec3;
      position[axis] = value;
      return [{ type: 'mesh.vertex.set', payload: { id: object.id, index: vertex, position } }];
    });
  const addFace = () => {
    try {
      const indices: unknown = JSON.parse(faceIndices);
      if (
        !Array.isArray(indices) ||
        indices.length < 3 ||
        !indices.every((index) => Number.isInteger(index) && index >= 0)
      )
        throw new Error('面片索引需要至少三个非负整数');
      editor.run('mesh.face.add', { id: object.id, indices });
    } catch (error) {
      editor.setError((error as Error).message);
    }
  };
  return (
    <>
      <div className="two-fields">
        <span>{mesh.vertices.length} 顶点</span>
        <span>{mesh.faces.length} 面片</span>
      </div>
      <Field label="顶点索引">
        <NumberInput
          value={vertex}
          min={0}
          max={mesh.vertices.length - 1}
          step={1}
          label="顶点索引"
          onChange={(value) => setSelectedVertex(Math.floor(value))}
        />
      </Field>
      <VectorInput
        label="顶点坐标"
        value={mesh.vertices[vertex]}
        onChange={(position) => editor.run('mesh.vertex.set', { id: object.id, index: vertex, position })}
        onAxisChange={setVertexAxis}
      />
      <IconButton
        icon={Trash2}
        label="删除未引用顶点"
        onClick={() => editor.run('mesh.vertex.delete', { id: object.id, index: vertex })}
      />
      <VectorInput label="新顶点坐标" value={newVertex} onChange={setNewVertex} />
      <button
        className="text-button"
        onClick={() => editor.run('mesh.vertex.add', { id: object.id, position: newVertex })}
      >
        <Plus size={14} />
        添加顶点
      </button>
      <Field label="面片索引">
        <NumberInput
          value={face}
          min={0}
          max={mesh.faces.length - 1}
          step={1}
          label="面片索引"
          onChange={(value) => setSelectedFace(Math.floor(value))}
        />
      </Field>
      <Field label="面片顶点">
        <output>{mesh.faces[face].join(', ')}</output>
      </Field>
      <Field label="挤出距离">
        <NumberInput value={distance} label="挤出距离" suffix="m" onChange={setDistance} />
      </Field>
      <div className="row">
        <button
          className="text-button"
          onClick={() => editor.run('mesh.face.extrude', { id: object.id, faceIndex: face, distance })}
        >
          <ArrowUpFromLine size={14} />
          挤出面片
        </button>
        <IconButton
          icon={Trash2}
          label="删除面片"
          disabled={mesh.faces.length <= 1}
          onClick={() => editor.run('mesh.face.delete', { id: object.id, faceIndex: face })}
        />
      </div>
      <Field label="新面片索引">
        <TextInput label="新面片索引" value={faceIndices} onChange={setFaceIndices} />
      </Field>
      <button className="text-button" onClick={addFace}>
        <Plus size={14} />
        创建面片
      </button>
      <label className="row">
        <input
          type="checkbox"
          checked={mesh.smooth}
          onChange={(event) => {
            const smooth = event.target.checked;
            editor.run((latest) => {
              const current = latestModel(latest, object.id);
              if (current.kind !== 'mesh') throw new Error('对象已转换为其他建模类型');
              return [
                {
                  type: 'mesh.set',
                  payload: {
                    id: object.id,
                    mesh: { ...current, smooth },
                  },
                },
              ];
            });
          }}
        />
        平滑法线
      </label>
    </>
  );
}

function CurveControls({
  object,
  curve,
  editor,
}: {
  object: SceneObject;
  curve: CurveData;
  editor: EditorActions;
}) {
  const [selected, setSelected] = useState(0);
  const point = Math.min(selected, curve.points.length - 1);
  const update = (patch: Partial<CurveData> | ((current: CurveData) => Partial<CurveData>)) =>
    editor.run((latest) => {
      const current = latestModel(latest, object.id);
      if (current.kind !== 'curve') throw new Error('曲线已变化，请重新选择');
      return [
        {
          type: 'curve.set',
          payload: {
            id: object.id,
            curve: { ...parameters(current), ...(typeof patch === 'function' ? patch(current) : patch) },
          },
        },
      ];
    });
  return (
    <>
      <Field label="截面">
        <select
          aria-label="曲线截面"
          value={curve.profile}
          onChange={(event) => update({ profile: event.target.value as CurveData['profile'] })}
        >
          <option value="road">道路</option>
          <option value="tube">管线</option>
        </select>
      </Field>
      <label className="row">
        <input
          type="checkbox"
          checked={curve.closed}
          onChange={(event) => update({ closed: event.target.checked })}
        />
        闭合曲线
      </label>
      <Field label="采样段数">
        <NumberInput
          value={curve.segments}
          min={2}
          max={2048}
          step={1}
          label="曲线采样段数"
          onChange={(segments) => update({ segments: Math.floor(segments) })}
        />
      </Field>
      {curve.profile === 'road' ? (
        <>
          <Field label="道路宽度">
            <NumberInput
              value={curve.width}
              min={0.01}
              label="道路宽度"
              suffix="m"
              onChange={(width) => update({ width })}
            />
          </Field>
          <Field label="道路厚度">
            <NumberInput
              value={curve.thickness}
              min={0.01}
              label="道路厚度"
              suffix="m"
              onChange={(thickness) => update({ thickness })}
            />
          </Field>
          <Field label="道路倾角">
            <NumberInput
              value={curve.bank}
              min={-80}
              max={80}
              label="道路倾角"
              suffix="deg"
              onChange={(bank) => update({ bank })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="管线半径">
            <NumberInput
              value={curve.radius}
              min={0.01}
              label="管线半径"
              suffix="m"
              onChange={(radius) => update({ radius })}
            />
          </Field>
          <Field label="截面段数">
            <NumberInput
              value={curve.radialSegments}
              min={3}
              max={64}
              step={1}
              label="截面段数"
              onChange={(radialSegments) => update({ radialSegments: Math.floor(radialSegments) })}
            />
          </Field>
        </>
      )}
      <Field label="控制点">
        <select
          aria-label="曲线控制点"
          value={point}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {curve.points.map((_, index) => (
            <option key={index} value={index}>
              {index + 1}
            </option>
          ))}
        </select>
      </Field>
      <VectorInput
        label="控制点位置"
        value={curve.points[point]}
        onChange={(position) =>
          update((current) => ({
            points: current.points.map((value, index) => (index === point ? position : value)),
          }))
        }
        onAxisChange={(axis, value) =>
          update((current) => {
            const points = current.points.map((position) => [...position] as Vec3);
            points[point][axis] = value;
            return { points };
          })
        }
      />
      <div className="row">
        <button
          className="text-button"
          onClick={() =>
            update((current) => {
              const end = current.points.at(-1)!;
              const previous = current.points.at(-2)!;
              return {
                points: [...current.points, end.map((value, axis) => value + value - previous[axis]) as Vec3],
              };
            })
          }
        >
          <Plus size={14} />
          添加控制点
        </button>
        <IconButton
          icon={Trash2}
          label="删除控制点"
          disabled={curve.points.length <= (curve.closed ? 3 : 2)}
          onClick={() =>
            update((current) => ({ points: current.points.filter((_, index) => index !== point) }))
          }
        />
      </div>
    </>
  );
}

function TerrainControls({
  object,
  terrain,
  editor,
}: {
  object: SceneObject;
  terrain: TerrainData;
  editor: EditorActions;
}) {
  const [row, setRow] = useState(0);
  const [column, setColumn] = useState(0);
  const [center, setCenter] = useState<[number, number]>([0, 0]);
  const [radius, setRadius] = useState(8);
  const [amount, setAmount] = useState(2);
  const [mode, setMode] = useState<'raise' | 'flatten' | 'smooth'>('raise');
  const selectedRow = Math.min(row, terrain.segmentsZ);
  const selectedColumn = Math.min(column, terrain.segmentsX);
  const update = (patch: Partial<TerrainData>) =>
    editor.run((latest) => {
      const current = latestModel(latest, object.id);
      if (current.kind !== 'terrain') throw new Error('地形已变化，请重新选择');
      return [
        {
          type: 'terrain.set',
          payload: {
            id: object.id,
            terrain: {
              sizeX: current.sizeX,
              sizeZ: current.sizeZ,
              segmentsX: current.segmentsX,
              segmentsZ: current.segmentsZ,
              thickness: current.thickness,
              ...patch,
            },
          },
        },
      ];
    });
  return (
    <>
      <div className="two-fields">
        <Field label="宽度 X">
          <NumberInput
            value={terrain.sizeX}
            min={0.1}
            max={100000}
            label="地形宽度"
            suffix="m"
            onChange={(sizeX) => update({ sizeX })}
          />
        </Field>
        <Field label="长度 Z">
          <NumberInput
            value={terrain.sizeZ}
            min={0.1}
            max={100000}
            label="地形长度"
            suffix="m"
            onChange={(sizeZ) => update({ sizeZ })}
          />
        </Field>
      </div>
      <div className="two-fields">
        <Field label="X 分段">
          <NumberInput
            value={terrain.segmentsX}
            min={1}
            max={200}
            step={1}
            label="地形 X 分段"
            onChange={(segmentsX) => update({ segmentsX: Math.floor(segmentsX) })}
          />
        </Field>
        <Field label="Z 分段">
          <NumberInput
            value={terrain.segmentsZ}
            min={1}
            max={200}
            step={1}
            label="地形 Z 分段"
            onChange={(segmentsZ) => update({ segmentsZ: Math.floor(segmentsZ) })}
          />
        </Field>
      </div>
      <Field label="基座厚度">
        <NumberInput
          value={terrain.thickness}
          min={0.01}
          label="地形基座厚度"
          suffix="m"
          onChange={(thickness) => update({ thickness })}
        />
      </Field>
      <div className="two-fields">
        <Field label="网格行">
          <NumberInput
            value={selectedRow}
            min={0}
            max={terrain.segmentsZ}
            step={1}
            label="地形网格行"
            onChange={(value) => setRow(Math.floor(value))}
          />
        </Field>
        <Field label="网格列">
          <NumberInput
            value={selectedColumn}
            min={0}
            max={terrain.segmentsX}
            step={1}
            label="地形网格列"
            onChange={(value) => setColumn(Math.floor(value))}
          />
        </Field>
      </div>
      <Field label="格点高度">
        <NumberInput
          value={terrain.heights[selectedRow * (terrain.segmentsX + 1) + selectedColumn]}
          label="地形格点高度"
          suffix="m"
          onChange={(height) =>
            editor.run('terrain.point.set', {
              id: object.id,
              row: selectedRow,
              column: selectedColumn,
              height,
            })
          }
        />
      </Field>
      <Field label="笔刷">
        <select
          aria-label="地形笔刷"
          value={mode}
          onChange={(event) => {
            const next = event.target.value as typeof mode;
            setMode(next);
            if (next === 'smooth') setAmount(0.5);
          }}
        >
          <option value="raise">升高 / 降低</option>
          <option value="flatten">拉平</option>
          <option value="smooth">平滑</option>
        </select>
      </Field>
      <div className="two-fields">
        <Field label="中心 X">
          <NumberInput
            value={center[0]}
            label="笔刷中心 X"
            onChange={(value) => setCenter([value, center[1]])}
          />
        </Field>
        <Field label="中心 Z">
          <NumberInput
            value={center[1]}
            label="笔刷中心 Z"
            onChange={(value) => setCenter([center[0], value])}
          />
        </Field>
      </div>
      <Field label="笔刷半径">
        <NumberInput value={radius} min={0.01} label="笔刷半径" suffix="m" onChange={setRadius} />
      </Field>
      <Field label={mode === 'smooth' ? '平滑强度' : mode === 'flatten' ? '目标高度' : '高度变化'}>
        <NumberInput
          value={amount}
          min={mode === 'smooth' ? 0 : -100000}
          max={mode === 'smooth' ? 1 : 100000}
          label="地形笔刷数值"
          onChange={setAmount}
        />
      </Field>
      <button
        className="text-button"
        onClick={() => editor.run('terrain.sculpt', { id: object.id, center, radius, amount, mode })}
      >
        <Paintbrush size={14} />
        应用笔刷
      </button>
    </>
  );
}

export function ModelingPanel({ object, project, editor, sourceTime }: Props) {
  const [createKind, setCreateKind] = useState<
    'mesh' | 'road' | 'tube' | 'terrain' | 'surface-sweep' | 'surface-revolve' | 'surface-loft'
  >('mesh');
  const [operandId, setOperandId] = useState('');
  const [operation, setOperation] = useState<'union' | 'subtract' | 'intersect'>('subtract');
  const [keepOperand, setKeepOperand] = useState(false);
  if (object.type === 'actor' || object.type === 'group') return null;
  const convertible = supportsMeshConversion(object);
  const unsupportedReason = '此对象的原始几何不支持网格转换';
  const modeling = object.modeling?.kind === 'stack' ? object.modeling.base : object.modeling;
  const create = () => {
    if (createKind === 'mesh') editor.run('mesh.convert', { id: object.id });
    else if (
      createKind === 'surface-sweep' ||
      createKind === 'surface-revolve' ||
      createKind === 'surface-loft'
    )
      editor.run('surface.set', {
        id: object.id,
        surface: defaultSurface(
          createKind === 'surface-sweep' ? 'sweep' : createKind === 'surface-revolve' ? 'revolve' : 'loft',
        ),
      });
    else if (createKind === 'terrain')
      editor.run('terrain.set', {
        id: object.id,
        terrain: { sizeX: 40, sizeZ: 40, segmentsX: 20, segmentsZ: 20 },
      });
    else
      editor.run('curve.set', {
        id: object.id,
        curve: {
          points: [
            [0, 0, 0],
            [0, 0, 5],
            [3, 0, 10],
          ],
          profile: createKind === 'road' ? 'road' : 'tube',
          segments: 48,
        },
      });
  };
  const operands = project.objects.filter(
    (candidate) => candidate.id !== object.id && supportsMeshConversion(candidate),
  );
  const validOperandId = operands.some((candidate) => candidate.id === operandId) ? operandId : '';
  const TitleIcon = modeling?.kind === 'terrain' ? Mountain : modeling?.kind === 'curve' ? Route : Box;
  return (
    <Section title="几何建模" extra={<TitleIcon size={14} />}>
      <fieldset disabled={object.locked || editor.busy}>
        <Field label="建模类型">
          <select
            aria-label="建模类型"
            value={createKind}
            onChange={(event) => setCreateKind(event.target.value as typeof createKind)}
          >
            <option value="mesh">可编辑网格</option>
            <option value="road">曲线路面</option>
            <option value="tube">曲线管线</option>
            <option value="terrain">高度地形</option>
            <option value="surface-sweep">截面扫掠</option>
            <option value="surface-revolve">旋转曲面</option>
            <option value="surface-loft">多截面放样</option>
          </select>
        </Field>
        <button
          className="text-button full-width"
          onClick={create}
          disabled={createKind === 'mesh' && !convertible}
          title={createKind === 'mesh' && !convertible ? unsupportedReason : undefined}
        >
          <Plus size={14} />
          {createKind === 'mesh'
            ? object.modeling?.kind === 'stack'
              ? '烘焙为网格'
              : '转换为网格'
            : '创建几何体'}
        </button>
        <ModifierPanel object={object} project={project} editor={editor} />
        {modeling?.kind === 'surface' && (
          <SurfacePanel key={object.id + '-surface'} object={object} surface={modeling} editor={editor} />
        )}
        {modeling?.kind === 'mesh' && (
          <>
            <TopologyPanel
              key={object.id + '-topology'}
              object={object}
              mesh={modeling}
              project={project}
              editor={editor}
            />
            <details className="topology-details">
              <summary>基础网格编辑</summary>
              <MeshControls key={object.id + '-mesh'} object={object} mesh={modeling} editor={editor} />
            </details>
          </>
        )}
        {modeling?.kind === 'curve' && (
          <CurveControls key={object.id + '-curve'} object={object} curve={modeling} editor={editor} />
        )}
        {modeling?.kind === 'terrain' && (
          <TerrainControls key={object.id + '-terrain'} object={object} terrain={modeling} editor={editor} />
        )}
        <Field label="布尔运算">
          <select
            aria-label="布尔运算"
            value={operation}
            onChange={(event) => setOperation(event.target.value as typeof operation)}
          >
            <option value="subtract">差集</option>
            <option value="union">并集</option>
            <option value="intersect">交集</option>
          </select>
        </Field>
        <Field label="操作对象">
          <select
            aria-label="布尔操作对象"
            value={validOperandId}
            onChange={(event) => setOperandId(event.target.value)}
          >
            <option value="">选择对象</option>
            {operands.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="row">
          <input
            type="checkbox"
            checked={keepOperand}
            onChange={(event) => setKeepOperand(event.target.checked)}
          />
          保留操作对象可见
        </label>
        <button
          className="text-button full-width"
          disabled={!convertible || !validOperandId || object.modeling?.kind === 'stack'}
          title={
            !convertible
              ? unsupportedReason
              : object.modeling?.kind === 'stack'
                ? '先烘焙修改器，再执行布尔运算'
                : undefined
          }
          onClick={() =>
            editor.run('mesh.boolean', { id: object.id, operandId: validOperandId, operation, keepOperand })
          }
        >
          <Combine size={14} />
          执行布尔
        </button>
      </fieldset>
      <ModelAssetsPanel
        key={object.id + '-assets'}
        object={object}
        project={project}
        editor={editor}
        sourceTime={sourceTime}
      />
    </Section>
  );
}
