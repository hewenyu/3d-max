# Topology Kernel

This directory provides pure geometry operations over indexed polygon meshes.
The public domain adapter is `shared/topology-commands.ts`; persistence, guards,
history and MCP registration remain outside this kernel. All editing functions
clone their inputs and return `MeshEditResult` with component identity changes.

## Identity

`ensureMeshIdentity` derives deterministic metadata for legacy geometry without
changing its input. Persist it only when a real edit occurs. Identity version 1
has a namespace, a shared monotonic allocation counter, vertex IDs and face IDs.
Edge IDs derive from their numerically ordered endpoint IDs. Selection carries
the namespace and component IDs; deleted or foreign selections are rejected.
Results report preserved, created and deleted IDs plus explicit replacements.
Replacing geometry through another modeling system must preserve proven lineage
or start a new namespace. Index compaction alone must not change surviving IDs.

## Operations

| Operation | Actual behavior and constraints                                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection | Vertex, edge and face replacement, connected, grow, shrink and invert. Loop and ring traverse unambiguous quad neighborhoods and report boundary, non-quad, non-manifold and pole stops.                                                                                                                                    |
| Transform | Local XYZ Euler degrees, translation, scale, pivot, orientation or an exclusive nonsingular affine matrix. Linear, smooth, sharp and constant proportional falloffs use spatial or connected edge distance. World/normal frames and snap are handled by the domain adapter.                                                 |
| Extrude   | Region caps share new vertices; individual faces have independent caps. Region boundaries create side walls. Direction defaults to the area-weighted selected normal.                                                                                                                                                       |
| Inset     | True in-plane boundary offsets with optional depth. Regions must be planar with consistent normals. Offset collapse, self-crossing, reversing corners and inverted interior faces fail.                                                                                                                                     |
| Fill      | Complete simple planar edge loops. Nested loops retain holes through triangulated caps with matching winding. Open chains and branched boundaries fail.                                                                                                                                                                     |
| Bridge    | Exactly two disjoint complete boundary loops with equal vertex counts; 1 to 64 segments and an integer correspondence twist. Shortest summed pairing is the default.                                                                                                                                                        |
| Weld      | Selected vertices merge transitively within a local distance tolerance. First retains the lowest allocation ID; center uses the group centroid. Collapsed and duplicate faces are removed with mappings.                                                                                                                    |
| Merge     | Explicit first, center or cursor target. First follows ordered selection. Cursor requires a local position. Collapsed faces are removed or rejected by the requested policy.                                                                                                                                                |
| Dissolve  | Edges merge planar face regions with one simple boundary; any enclosed unselected edge must be selected explicitly. Vertex dissolve removes collinear degree-two points.                                                                                                                                                    |
| Split     | Region boundary mode duplicates shared vertices on the selected side; individual mode separates selected faces. Face IDs remain stable and duplicated vertex/edge lineage is returned.                                                                                                                                      |
| Delete    | Vertex/edge deletion requires explicit incident-face rejection or deletion. Optional loose-vertex removal stays within affected geometry. Deleting every face is rejected; delete the scene object instead.                                                                                                                 |
| Loop Cut  | One seed edge, 1 to 32 cuts along a quad ring. Positive slide follows the seed's ascending stable endpoint IDs. Shared cut vertices are inserted into neighboring non-quad boundaries to avoid T-junctions.                                                                                                                 |
| Slide     | Interior quad edge chains or equivalent vertex selections move along consistently oriented side rails. Branches, isolated vertices, ambiguous rails and endpoint collapse are rejected.                                                                                                                                     |
| Bisect    | Whole mesh against the local plane `dot(normal, point) = offset`; positive, negative or both sides. Concave crossing polygons use Three.js triangulation. One-sided caps preserve nested holes.                                                                                                                             |
| Repair    | Explicit selected duplicate/degenerate-face removal, affected loose-vertex removal and orientation repair. Unselected faces constrain consistent orientation. Outward orientation requires complete closed components.                                                                                                      |
| Bevel     | Actual edge-profile plane clipping on closed, planar-faced, globally convex outward shells. Width is tangent setback along each incident face; 1 to 16 facets interpolate from a flat chamfer to a circular arc. Intersections produce closed miter corners. Adjacent cuts cannot consume source faces or profile segments. |

Bevel currently rejects open boundaries and concave shells with component-level
diagnostics; it does not claim arbitrary concave Boolean-edge beveling. It uses
miter intersections at vertices, not spherical corner patches. A flat profile
reports one effective segment even when more segments were requested. Coplanar
edges are omitted by default and rejected when explicitly selected.

## Validation And Capacity

Meshes allow at most 100,000 vertices, 100,000 faces, 256 vertices per polygon,
150,000 triangles and coordinates within 100,000 meters. Fills allow up to 2,048
boundary vertices when triangulating; bridges allow 2,048 vertices per loop.
Bevel permits at most 256 profile planes. Spatial nearest-neighbor and duplicate
searches and convex validation have explicit comparison budgets; overflow fails
before publication. Connected proportional editing uses multi-source Dijkstra.

Diagnostics report open boundaries, non-manifold edges and disconnected vertex
fans, inconsistent winding, duplicates, nonplanarity, degenerate or self-crossing
faces, loose vertices and connectivity. Self-crossing diagnostics concern each
polygon, not a claim of exhaustive mesh-against-mesh intersection detection.
Open meshes and intentional coincident split boundaries are valid modeling
states. Editing rejects malformed indices, collapsed edges/face area and planar
self-crossing results; it does not silently repair unrelated geometry.

Tests in `tests/topology*.test.ts` cover real geometric volume/area, normal and
manifold checks, nested voids, component lineage, source immutability, malformed
input, parent transforms, SQLite restart, locks, atomic failure and exact undo.
The MCP catalog uses `tests/fixtures/topology-command-cases.ts` for real edits.
