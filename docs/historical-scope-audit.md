# Historical Scope Audit

Audit date: 2026-09-07. This document records historical wording, implementation evidence and the user's subsequent scope decision. The original [full-goal.md](full-goal.md) remains verbatim; [scope-decisions.md](scope-decisions.md) records the authorized clarification. Earlier first-version exclusions alone were not authorization to remove capabilities.

## User Decision On H07 And H08

The user supplied the following complete decision, preserved verbatim:

> 雕刻、复杂拓扑、专业材质、布料/毛发/流体等专业能力 这些能力暂时不需要，这个可以靠参考图来实现，内置聊天助手和外部生成式 3D 服务 这个没那个必要，只需要开放MCP给外部的agent 去交互就行了，所有web 能用的能力都可以通过mcp来实现

H07 and H08 are now **resolved by user scope decision**. This resolves the former uncertainty; it does not claim that the omitted professional extensions, built-in chat or external generative 3D integration were implemented. Existing basic modeling, terrain, modifiers, actor IK/contact, necessary physical helpers, expressions and lip-sync remain part of the delivered product and its verification.

The final clause strengthens acceptance: every capability available through the Web application must have a real MCP equivalent. The 151-tool standalone-success record establishes that those registered tools were invoked; it does not establish coverage of every Web capability. Capability-by-capability mapping, shared behavior and actual outcomes remain required. The user's reference-image explanation does not request a new reference-image feature. Scope resolution does not mark the overall objective complete.

## H01: Geometry And Modifiers

Original PRD 4.1, lines 97-98:

> 后续增强：挤出、布尔、曲线、吸附增强及可复用场景模板。
> 进一步扩展：更深入的网格编辑、修改器或外部生成式 3D 服务。

The active full goal, section 3.2, explicitly requires mesh editing, extrusion, Boolean operations, curves, terrain and reusable templates. Matrix H01 additionally names an editable operation stack. Existing vertex/face commands, CSG and parametric curve/terrain editing addressed geometric authoring but destructively replaced geometry; history alone did not satisfy editable modifier settings.

The new general modifier stack retains a parametric or mesh source and ordered mirror, array and Loop subdivision settings. Users and MCP can add, edit, disable, reorder, remove and bake modifiers. Existing mesh, curve and terrain controls edit the retained source. Evaluated geometry is shared by viewport rendering, exported frames, collision geometry and continuity checks. Mirror copies have corrected winding but are not welded; intersecting copies are not automatically fused. Boolean modeling of a stack target requires an explicit bake. Complexity limits reject excessive results atomically. This is not a claim of every modifier available in a general DCC package.

Implementation: `shared/modifier-schema.ts`, `modifier-evaluation.ts`, `modifier-operations.ts`, `modeling.ts`, `modeling-operations.ts`; UI `src/components/ModifierPanel.tsx` within object geometry controls. The shared command registry exposes `modifier_add`, `modifier_set`, `modifier_remove`, `modifier_reorder`, `modifier_bake` over MCP. Subdivision uses `three-subdivide` 1.1.5. Templates are implemented separately in `shared/templates.ts` and the SQLite template services/library.

Verification: `tests/modifiers.test.ts` covers order, source edits, actual subdivided geometry, winding/volume, bypass/removal, bake, serialization, curve/terrain sources, limits, locks and rollback. It passes together with the existing modeling regression suite (15 checks). `tests/modifier-service.test.ts` passes actual MCP discovery/editing, idempotent replay, SQLite reopening, undo/redo and invalid-edit rollback. `tests/modifiers.spec.ts` passes real UI/MCP shared editing, source-stack ordering, desktop/mobile controls, moving canvas, bake/undo, reload and a real MCP rendered image (8.7 seconds total). Screenshots were inspected in `.data/modifier-test-results/modifiers-modifier-stack-U-907f7-es-mobile-controls-and-undo/`. Final full-suite acceptance remains the root delivery gate.

## H07: Professional Extensions, Scope Resolved

Original PRD section 7, line 274:

> 首版不纳入完整雕刻、复杂拓扑编辑、专业材质节点、布料毛发、流体、复杂动力学和高级面部动画。完整产品可按真实创作需求逐步增加能力。

The active goal section 2 required review of every deferred item and an explicit user decision for a scope change. That decision is now recorded above. The professional extensions below are temporarily outside this delivery; their existing basic counterparts and all other applicable requirements remain subject to acceptance.

| Historical item             | Current evidence                                                                                                                                                                                                      | Authorized boundary                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete sculpting          | `terrain.sculpt` provides raise, flatten and smoothing brushes over editable height fields; indexed mesh vertices are editable. General surface sculpting, dynamic topology and multiresolution sculpting are absent. | Professional sculpting is temporarily not required. Terrain and basic mesh editing remain required; they are not described as a complete sculpt system.                                                                                                                   |
| Complex topology editing    | Indexed vertex/face editing, extrusion, CSG, curves, terrain and a non-destructive modifier stack exist.                                                                                                              | Professional topology extensions are temporarily not required. Existing basic mesh authoring and modifiers remain available and must retain MCP equivalence.                                                                                                              |
| Professional material nodes | Neutral materials, tones, lighting, shadows and optical focus exist. Imported meshes use the white-model material; there is no node material graph.                                                                   | Professional material authoring is temporarily not required. White-model materials and lighting remain required.                                                                                                                                                          |
| Cloth                       | Imported geometry or rigs can depict garments; no cloth solver exists.                                                                                                                                                | A professional cloth system is temporarily not required. Authored geometry and rig animation are not claimed to be cloth simulation.                                                                                                                                      |
| Hair                        | Imported geometry can carry a silhouette; no strand/groom system or hair solver exists.                                                                                                                               | Professional hair authoring and simulation are temporarily not required.                                                                                                                                                                                                  |
| Fluids                      | No fluid surface, solver or volumetric fluid system exists.                                                                                                                                                           | Professional fluid capabilities are temporarily not required. Existing white-model projectile, hit and explosion proxies remain available.                                                                                                                                |
| Complex dynamics            | Rapier rigid-body helpers, collision, gravity/zero-gravity, kinematic bodies, editable baked tracks, actor IK/contact, coordinated paths and vehicle/flight poses exist.                                              | Necessary physical helpers remain required. The user's professional-extension boundary covers additional cloth, fluid, soft-body or coupled simulation systems; it does not remove the implemented physics used by the films.                                             |
| Advanced facial animation   | H02/H03 provide editable expressions and audio-to-viseme analysis.                                                                                                                                                    | Existing expressions and lip-sync remain required and are verified separately. This delivery does not expand into professional facial capture or photoreal solving under the professional-extension boundary. Imported-model compatibility retains its documented limits. |

This temporary boundary comes from the user's decision, not from implementation cost or the original first-version label. H07 is scope-resolved, not an implementation claim for the absent systems.

## H08: External Agent Entry, Scope Resolved

Original PRD 4.1, line 98, uses the alternative phrase “修改器或外部生成式 3D 服务”. The following paragraph explicitly defines AI modeling as AI calling tools to create/edit actual 3D scenes and calls arbitrary-text generation of complex people or fine models an additional capability. PRD section 5, line 239, states:

> MCP 是接入协议。外部 AI 的自然语言理解、任务规划和视觉判断由所接入的 Agent 提供；内置聊天助手是可单独增加的产品入口。

PRD section 6, line 252, states:

> AI 状态区域：连接状态、当前操作和任务结果；聊天入口按后续范围决定。

| Item                                                 | Current evidence                                                                                                                                                        | Authorized boundary                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External Agent operates real 3D software through MCP | The official server exposes shared project, modeling, animation, camera, time, inspection and render operations; production journals record real calls.                 | Mandatory and strengthened: every Web capability requires an equivalent MCP entry and verified outcome. Existing tool invocation counts do not establish this full coverage. |
| External generative 3D provider                      | No provider client, generation job, provider key setting or returned-asset workflow exists. GLB/glTF import and procedural modeling do not imply text-to-3D generation. | The user explicitly does not require this integration. H08 is resolved without claiming the integration was delivered.                                                       |
| Built-in chat assistant                              | MCP connection configuration and operation feedback exist; no internal LLM conversation/provider interface exists.                                                      | The user explicitly does not require built-in chat. Understanding, planning and interaction are supplied by the external Agent through MCP.                                  |

The product explicitly stops at white-model video. None of the above authorizes integration with downstream AI video-generation platforms.

The strengthened MCP acceptance is tracked separately from the H08 scope decision. For example, [the historical four-film package records](four-films.md#portable-projects-and-reopening) use HTTP multipart for racing/space because the earlier MCP base64 input was limited to 32 MiB. The subsequent [four-package MCP-only suite](../.data/full-delivery/final-candidate-09/mcp-package-checks-complete/suite-report.json) verifies the new general chunked transfer against those actual archives, including history, assets, editing, shot rendering and recovery after a real restart. Other capabilities have their own [Web/MCP mapping](web-mcp-parity.md); the H08 scope decision alone does not establish parity.

## H09: Lighting Plans

Original PRD section 4.6, line 186 explicitly defers lighting plans alongside visible depth of field and rack focus. Previous H01-H08 rows omitted that named capability. Basic scene lighting and a template that happens to carry lighting settings are not independent plan authoring.

This item is implemented: named editable project lighting plans, scene defaults, independent shot overrides, shared UI/MCP commands, referenced-plan validation, indirect lock protection, template remapping and shared preview/export resolution. The plan uses the established white-model key/ambient lighting parameters; this does not claim professional material nodes or a general DCC light graph. `lighting-plans.test.ts`, `lighting-service.test.ts` and `lighting-plans.spec.ts` provide domain, SQLite, actual UI/MCP and PNG/MP4 agreement evidence. The final frozen-version gate remains recorded in the delivery matrix.
