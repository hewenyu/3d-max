# Editable Surface Kernel

`surfaceDataSchema` is the source schema. `surfaceToMesh(source)` returns a new
indexed triangle `MeshData` without modifying the source. Integration stores the
source, and `mesh.convert` is the explicit destructive conversion to editable
topology. `surface.set` accepts `{ id, surface }`.

## Coordinates And Sampling

- Coordinates and thickness are object-local meters; angles are degrees.
- A knot has `position`, optional `inTangent`, and optional `outTangent`. Handles
  are vectors relative to the knot. An unhandled span is an exact line. When just
  one handle is present, the missing handle uses one third of the endpoint chord.
- `closed` joins the last knot to the first. Do not repeat the first knot.
- `segments` samples every sweep path span or loft section interval. For a
  revolution it is the number of angular segments over `angle`.
- `profileSegments` samples every profile span, including straight spans. Caps
  retain sampled collinear boundary vertices, so their edges match the walls.
- A result is a polygonal approximation at the requested resolution. Validation
  checks that evaluated geometry, not an exact CAD/NURBS surface. Interior
  reversing Bezier cusps are also checked from derivative roots before sampling.

## Operations

`sweep` requires a 3D `path` and a `profile` containing a closed `outer` 2D curve
and zero or more closed `holes`. Profile XY coordinates map to the Three.js
Frenet normal/binormal frame. The initial frame follows Three.js's deterministic
frame convention. Reversing the path preserves outward winding; asymmetric
profiles can change world orientation with that frame. Closed paths weld the
seam. Open paths honor `caps`.

`revolve` takes a 2D meridian `profile` whose coordinates are `[radius, height]`
about local Y. `startAngle` defaults to zero and `angle` to 360. A positive angle
rotates +X toward -Z. Open meridians implicitly close to the axis for orientation
and, when capped, for the end disks and angular-cut faces. Only open-profile
endpoints may touch the axis; coincident poles are welded. Closed off-axis
profiles create toroidal solids. Negative radii and intermediate axis contacts
are rejected.

`loft` takes `sections`, each with a profile, local `position` and XYZ Euler
`rotation`. Sections must have matching loop counts and knot counts per loop.
The first knot is the seam and hole order is explicit correspondence. Winding is
normalized while retaining the seam. Section planes must advance consistently
along travel; reversed, overlapping or transverse planes fail. `interpolation`
is `linear` or Three.js `centripetal` Catmull-Rom, defaulting to `centripetal`.
Closed lofts need at least three sections and weld the seam.

## Thickness And Validation

`thickness: 0` produces the requested surface or capped solid. Positive thickness
preserves that outer surface and adds an inward shell. At each vertex, a
regularized least-squares solve intersects the incident offset planes. Coplanar
constraints are deduplicated, and displacement is conservatively scaled so each
incident plane receives at least the requested offset. This is a polygonal miter
shell, not an analytic CAD offset. Displacement above four times the thickness,
folded inner faces, collapsed faces and self-intersections fail. Open boundaries
receive rims; closed inputs receive a closed inner cavity.

The generic `assertNoSelfIntersections(mesh)` accepts triangles and polygons.
Polygon faces are checked for crossings and triangulated using Three.js
ShapeUtils/Earcut. BVH broad-phase and ExtendedTriangle intersection testing come
from `three-mesh-bvh`. BVH indirect indices are mapped back to original triangles.
Near-coplanar pairs use projected separating axes within the kernel's geometric
tolerance, avoiding exact-plane roundoff failures on rotated caps. Collinear
contour samples are temporarily removed for triangulation and then reinserted
into the cap boundary, preventing zero-area triangles on tapered meridians.
Adjacent indexed triangles are tested after a 1e-6 relative contraction toward
their centroids, allowing their shared boundary while still detecting interior
overlap above that numerical neighborhood. Nonadjacent contact is rejected.

`assertSurfaceMeshValid(mesh, { closed?, selfIntersections? })` additionally checks
coordinates, area, winding, edge incidence, connected vertex fans and boundaries.
`shellMesh(mesh, thickness)` is separately reusable. Errors are `SurfaceError`
with `code`, HTTP `status: 400`, and optional local element details. Source and
input meshes are never modified by these helpers.

## Explicit Limits

- At most 128 source knots per curve, 16 holes, and 64 loft sections.
- `segments`: 1..256; `profileSegments`: 1..64; full revolution needs 3+ segments.
- At most 2048 sampled points across one section's outer and hole contours.
- At most 70000 generated vertices and 150000 triangles, including shell layers.
- At most 3000000 BVH candidate triangle pairs per self-intersection check.
- Generated coordinates must be finite and within +/-100000 meters.
- Geometric comparison epsilon is 1e-7 meters, with an area threshold of 1e-14.

The kernel is synchronous and bounded. Application integration must evaluate
complex geometry off the UI thread. These limits do not imply an interactive
latency promise; performance depends on section complexity and BVH overlap.
