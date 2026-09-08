import { z } from 'zod';

const finite = z.number().finite();
const distance = finite.min(-100000).max(100000);
const vector = z.tuple([distance, distance, distance]);
const identifier = z.string().min(1).max(200);
export const componentKindSchema = z.enum(['vertex', 'edge', 'face']);
export const componentSelectionSchema = z
  .object({
    namespace: z.string().min(1).max(120),
    kind: componentKindSchema,
    ids: z.array(z.string().min(1).max(64)).max(300000),
  })
  .strict();
export const componentSelectionRequestSchema = componentSelectionSchema
  .extend({
    operation: z.enum(['replace', 'connected', 'loop', 'ring', 'grow', 'shrink', 'invert']),
    steps: z.number().int().min(1).max(100).optional(),
  })
  .strict();
const target = z.object({ id: identifier }).strict();
const selected = target.extend({ selection: componentSelectionSchema }).strict();
export const topologySchemas = {
  'topology.transform': selected
    .extend({
      matrix: z.array(finite).length(16).optional(),
      translation: vector.optional(),
      rotation: vector.optional(),
      scale: vector.optional(),
      space: z.enum(['local', 'world', 'normal']).optional(),
      pivotMode: z.enum(['median', 'bounds', 'origin', 'active', 'custom']).optional(),
      pivot: vector.optional(),
      snap: z
        .object({
          translation: finite.positive().max(1000).optional(),
          rotation: finite.positive().max(180).optional(),
          scale: finite.positive().max(10).optional(),
        })
        .strict()
        .optional(),
      proportional: z
        .object({
          radius: finite.positive().max(100000),
          falloff: z.enum(['linear', 'smooth', 'sharp', 'constant']),
          connected: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'topology.extrude': selected
    .extend({
      distance,
      mode: z.enum(['region', 'individual']).optional(),
      direction: vector.optional(),
    })
    .strict(),
  'topology.inset': selected
    .extend({
      thickness: finite.positive().max(100000),
      depth: distance.optional(),
      mode: z.enum(['region', 'individual']).optional(),
    })
    .strict(),
  'topology.bevel': target
    .extend({
      selection: componentSelectionSchema.optional(),
      width: finite.positive().max(100000),
      segments: z.number().int().min(1).max(16).optional(),
      shape: finite.min(0).max(1).optional(),
    })
    .strict(),
  'topology.split': selected.extend({ mode: z.enum(['boundary', 'individual']).optional() }).strict(),
  'topology.delete': selected
    .extend({
      incidentFaces: z.enum(['reject', 'delete']).optional(),
      removeLooseVertices: z.boolean().optional(),
    })
    .strict(),
  'topology.merge': selected
    .extend({
      target: z.enum(['first', 'center', 'cursor']),
      position: vector.optional(),
      collapseFaces: z.enum(['remove', 'reject']).optional(),
    })
    .strict(),
  'topology.fill': selected.extend({ triangulate: z.boolean().optional() }).strict(),
  'topology.bridge': selected
    .extend({
      segments: z.number().int().min(1).max(64).optional(),
      twist: z.number().int().min(-2048).max(2048).optional(),
    })
    .strict(),
  'topology.weld': selected
    .extend({
      tolerance: finite.positive().max(1000),
      position: z.enum(['first', 'center']).optional(),
    })
    .strict(),
  'topology.dissolve': selected,
  'topology.loop-cut': selected
    .extend({
      cuts: z.number().int().min(1).max(32).optional(),
      slide: finite.gt(-1).lt(1).optional(),
    })
    .strict(),
  'topology.slide': selected.extend({ amount: finite.gt(-1).lt(1) }).strict(),
  'topology.bisect': target
    .extend({
      normal: vector,
      offset: distance,
      keep: z.enum(['both', 'positive', 'negative']).optional(),
      fill: z.boolean().optional(),
      tolerance: finite.positive().max(1).optional(),
    })
    .strict(),
  'topology.repair': target
    .extend({
      selection: componentSelectionSchema.optional(),
      removeDegenerateFaces: z.boolean().optional(),
      removeDuplicateFaces: z.boolean().optional(),
      removeLooseVertices: z.boolean().optional(),
      orientFaces: z.enum(['consistent', 'outward']).optional(),
    })
    .strict(),
};
const descriptions: Record<keyof typeof topologySchemas, string> = {
  'topology.transform':
    'Transform stable vertex/edge/face selection in local, base-pose world, or averaged-normal space. Distances are meters, rotation XYZ degrees. Pivot defaults to selection median; custom pivot uses the selected space. Proportional radius is measured in that space, connected distance follows mesh edges. Optional snap quantizes transform deltas. Returns affected weights and component mappings.',
  'topology.extrude':
    'Extrude selected polygon faces as a connected region or individual faces. Distance is local meters; optional local direction overrides the averaged normal. Preserves caps and returns stable component mappings. Unsupported boundaries fail atomically.',
  'topology.inset':
    'Inset planar polygon regions or individual faces by local-meter thickness with optional depth. Holes remain holes. Crossing or collapsed offsets fail atomically.',
  'topology.bevel':
    'Bevel selected non-coplanar edges or all such edges of a closed, consistently oriented convex source mesh. Width is local meters; 1..16 circular segments, shape 0 flat through 1 circular. Intersecting cuts, concave or open inputs fail with diagnostics. Returns true cut profiles and effective segments.',
  'topology.split':
    'Detach selected polygon faces from adjacent faces along region boundaries or split each selected face independently. Keeps local positions and reports original-to-new component mappings.',
  'topology.delete':
    'Delete selected source vertices, edges or faces. Vertex/edge deletion requires explicit incidentFaces reject or delete. Optional removeLooseVertices removes only affected unused vertices. Deleting every face fails; use object_delete to remove the whole object.',
  'topology.merge':
    'Merge selected vertices to the first selection ID, centroid or explicit local cursor position. collapseFaces remove deletes collapsed faces; reject aborts. Reports the surviving vertex and all component replacements.',
  'topology.fill':
    'Fill complete planar selected boundary edge loops; nested loops retain holes. Optional triangulate produces triangles. Open chains and self-crossing contours fail.',
  'topology.bridge':
    'Bridge exactly two complete, disjoint boundary edge loops with equal vertex counts. Segments 1..64; twist is an integer vertex offset. Returns editable connecting quads.',
  'topology.weld':
    "Merge selected components' vertices within a transitive distance tolerance in local meters. Position first keeps the lowest stable vertex ID; center uses each group centroid. Removes collapsed/duplicate faces and returns component replacements.",
  'topology.dissolve':
    'Dissolve selected planar interior edges into polygon faces, or collinear valence-two vertices. Incompatible, non-manifold or self-intersecting results fail atomically.',
  'topology.loop-cut':
    'Insert 1..32 cuts through the quadrilateral strip seeded by exactly one stable edge ID. Slide lies strictly between -1 and 1. Stops at non-quad boundaries; reports created components.',
  'topology.slide':
    'Slide a selected interior edge chain or its vertices along adjacent quad rails. Amount lies strictly between -1 and 1; branching or ambiguous rails fail.',
  'topology.bisect':
    'Cut source polygons by local plane dot(normal,point)=offset. Keep both sides or positive/negative side; fill caps only when keeping one side. Preserves concave split islands and cap holes.',
  'topology.repair':
    'Repair the source mesh with explicit options for duplicate/degenerate faces, loose vertices and consistent or outward orientation. Optional stable selection restricts scope; unsupported topology fails without partial changes.',
};
export const topologyCommandDefinitions = Object.entries(topologySchemas).map(([type, schema]) => ({
  type,
  schema,
  description: descriptions[type as keyof typeof topologySchemas],
}));

export const modelingReadGuardSchema = z
  .object({
    projectId: identifier,
    expectedRevision: z.number().int().min(0),
    expectedContext: z
      .object({ sceneId: identifier.nullable(), performanceId: identifier.nullable() })
      .strict(),
    objectId: identifier,
  })
  .strict();
export const meshInspectSchema = modelingReadGuardSchema
  .extend({
    stage: z.enum(['source', 'evaluated']).default('source'),
    kind: componentKindSchema.default('face'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(2000).default(200),
    tolerance: finite.positive().max(1000).optional(),
  })
  .strict();
export const meshSelectionQuerySchema = modelingReadGuardSchema
  .extend({
    selection: componentSelectionRequestSchema,
  })
  .strict();
export type ComponentTransformInput = z.infer<(typeof topologySchemas)['topology.transform']>;
