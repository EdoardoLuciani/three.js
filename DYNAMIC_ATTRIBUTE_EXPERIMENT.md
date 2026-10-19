# Local experiment: version-driven dynamic attribute uploads

## Current scope and result

Base: fork `origin/dev`, `0978e2b62e53654ebe1a2c3032ebee0a4981c701`.
Branch: `experiment/versioned-dynamic-attributes`.

The initial experiment, commit `63f454ce8`, removed
`|| attribute.usage === DynamicDrawUsage` from the common attribute upload rule.
It demonstrated unnecessary unchanged uploads, but exposed a matrix-wrapper
regression: even an explicit source `needsUpdate` was lost.

The follow-up retains that deletion and adds source-version forwarding in
`src/nodes/accessors/BufferAttributeNode.js`. **The explicitly published matrix
updates now work, all 15 focused tests pass, and neither full-suite configuration
has failures beyond its previously observed baseline failures.**

This is still not a drop-in compatibility-complete change: raw TypedArray inputs
to `dynamicBufferAttribute()` no longer automatically reflect unpublished
mutations. That API-policy question is intentionally unchanged by this follow-up.
This change is for review in the owner's fork, not an upstream submission. No
game dependency, game code, renderer hooks, or update-policy framework was added.

## Implementation

Matrix helpers split `mat3`/`mat4` data into three/four column nodes. A supplied
BufferAttribute with itemSize greater than four is wrapped in an internal
InterleavedBuffer; smaller BufferAttributes already retain the original source.
The deletion-only patch revealed that the wrapper did not follow its source's
version. The old unconditional dynamic uploads masked that missing propagation.

The follow-up:

- Schedules wrapped BufferAttributes through existing `NodeUpdateType.OBJECT`
  `updateBefore` callbacks, before geometry uploads. Ordinary node `update()` is
  later in the rendering sequence and is not the right place.
- Synchronizes the source array, count, dirty-range reference, and version when
  the version changes. This applies regardless of usage, not just DynamicDrawUsage.
- Borrows the source ranges rather than copying/clearing them in a column callback.
  The actual backend upload consumes them. This preserves ranges published between
  callbacks and avoids premature consumption by one of the column views.
- Keys cached wrappers by the actual source owner and stride. Columns of one
  source/layout share backing; independent version owners that alias one array,
  or different strides, do not accidentally share version/layout state.

Unchanged callbacks perform a constant-time version comparison, not an array
scan. Caches are populated during setup, not allocated per draw. The node change
is 42 added / 6 removed lines; the common Attributes deletion is unchanged.
Same-size source-array replacement is covered; buffer resizing is not introduced
as a supported feature.

## Focused regression tests

The committed tests exercise actual Attributes, WebGPUAttributeUtils,
BufferAttributeNode, and NodeFrame with a recording queue. The node harness runs
all `updateBefore` callbacks before geometry uploads, matching Renderer ordering.
The original matrix guard still checks that the published translation reaches
GPU upload data; it now also exercises all four columns and unchanged suppression.
No test was disabled, marked TODO, or weakened to hide a failure.

| Runtime under the current 15 tests | Passed | Failed |
| --- | ---: | ---: |
| Deletion only, original BufferAttributeNode served as a negative control | 8 | 7 |
| Deletion plus source forwarding | **15** | **0** |

Coverage includes unchanged static/dynamic/stream buffers; full and partial
updates; consumed and multiple ranges; shared interleaved views; allocation
recreation; explicitly published matrix changes; multiple versions in one
NodeFrame; ranges published between callbacks; aliased but independent owners;
different strides; mat3 columns; and same-size array replacement.

Historically, the initial nine-test deletion-only experiment had eight passes
and one real matrix regression. The additional tests strengthen that coverage;
the previous failure evidence is retained in the initial commit and local logs.

## Full suites and clean install

Browser: temporary official Chrome Beta 153.0.8010.12. A fresh
`PUPPETEER_SKIP_DOWNLOAD=1 npm ci` passed. No vulnerabilities were reported.
Validation was repeated after that clean install.

| Configuration | Total | Passed | TODO | Failed |
| --- | ---: | ---: | ---: | ---: |
| Default `npm test` core page | 1,983 | 1,979 | 1 | 3 |
| Hardware AMD RDNA-4 WebGPU core page | 1,983 | 1,980 | 1 | 2 |
| Separate default add-on suite | 116 | 116 | 0 | 0 |

The default failures are the same three observed on the original base:

- `textureBarrier`: unsupported RGBA32Float read/write storage-texture access.
- WebGL `triNoise3D` deterministic-output assertion.
- WebGL negative-operand integer `mod` assertions.

The hardware failures are the same two observed on the original base:

- `subgroupBallot` assertions assume <=32 lanes; this adapter uses 64.
- The same WebGL integer `mod` assertions.

A fresh hardware control serving both original runtime files with the same 15
new tests reports 1,968 passed, one TODO, and 14 failed. Twelve failures are the
new behavior/regression assertions; only the two listed above are failures in
the pre-existing suite. Do not interpret those intentionally new assertions as
14 pre-existing failures, or describe the patched full suites as green.

`npm test` runs source lint before core tests and stops on core failure; add-ons
were therefore run separately. Source/test ESLint, `npm run build`, script syntax,
and `git diff --check` passed. Generated build changes were restored. The complete
examples screenshot suite was not run.

## Paired hardware-WebGPU rendering

The extended fixture renders actual scenes into 32x32 targets and reads all RGBA
bytes. Two independent control/patch pairs selected nonfallback AMD RDNA-4 WebGPU,
with zero page errors and zero console errors. Controls serve both original
Attributes.js and BufferAttributeNode.js before module loading; other source is
identical. Only public WebGPU writes are wrapped for diagnostic counts.

Nine versioned cases have **zero differences across 327,680 paired image bytes**,
excluding the separately assessed source-array-replacement stage below:

- Dynamic geometry with full/partial updates and a second camera.
- Dynamic interleaved position/color data.
- Instancing capacities 1 (UBO path) and 4,097 (vertex-attribute path).
- Real shadow and beauty passes sharing dynamic geometry.
- TSL data backed by an owned InterleavedBuffer or direct vec3 BufferAttribute.
- Wrapped mat4 data: published full/partial updates, another camera, consumed
  ranges, and an explicit whole-buffer update after a partial update.
- Wrapped mat3 data with partial updates.

Both control and patch visibly change in every versioned case, so comparisons
are not vacuous. The previously frozen matrix translation now moves correctly.

Representative writes per fixture stage:

| Stage | Original | Patch |
| --- | ---: | ---: |
| Unchanged ordinary dynamic positions | 1 | 0 |
| Unchanged large-instanced matrices/colors | 2 | 0 |
| Unchanged shadow + beauty positions | 2 | 0 |
| Changed shadow + beauty positions | 2 | 1 |
| Unchanged wrapped mat4, including another camera | 1 | 0 |
| Published full mat4 update | 1 x 192 bytes | 1 x 192 bytes |
| Three disjoint mat4 component ranges | 1 x 192 bytes | 3 x 4 bytes |
| Three disjoint mat3 component ranges | 1 x 108 bytes | 3 x 4 bytes |

Range forwarding can increase calls for a sparse changed version while reducing
bytes; it uses the backend's existing per-range behavior. Unchanged uploads then
disappear. These are diagnostic counts, not a timing benchmark or an FPS claim.
The small-instancing raw UBO write remains; bone/uniform pooling is out of scope.

### Additional existing bug fixed: source array replacement

The matrix fixture also replaces the source with a same-size array, changes its
translation, and sets `source.needsUpdate = true`. The original runtime keeps
uploading the old array and leaves the triangle visible. The follow-up correctly
uses the replacement and moves it offscreen. Both pairs show the expected 1,014
changed image bytes. This stage is an improvement over an existing baseline bug,
not an image-parity success or a newly introduced regression.

### Remaining compatibility difference: unversioned raw arrays

`dynamicBufferAttribute( typedArray, 'vec3' )` still freezes after an unpublished
raw-array mutation under the version-driven rule. The original automatically
updates. Both pairs reproduce 1,014 differing bytes. Raw arrays have no source
version to forward; preserving automatic behavior or requiring explicit versioned
input remains an API decision. This patch does not silently choose a replacement
notification API or claim this difference is fixed.

Prior art remains relevant: [#26057](https://github.com/mrdoob/three.js/pull/26057),
[#28697](https://github.com/mrdoob/three.js/pull/28697),
[#28704](https://github.com/mrdoob/three.js/pull/28704), and
[#28716](https://github.com/mrdoob/three.js/pull/28716). Automatic dynamic uploads
are established behavior, not an undisputed accidental bug.

## Local evidence and reproduction

Follow-up artifacts (initial evidence remains under `/tmp/three-dynamic-*`):

- `/tmp/three-forward-{npm-ci,npm-test-clean,addons-clean,build-clean,test-lint}.log`.
- `/tmp/three-forward-targeted-final.json`: 15 focused passes.
- `/tmp/three-forward-no-forward-final.json`: eight passes/seven negative-control
  failures without source forwarding.
- `/tmp/three-forward-hardware-full-clean.json`: complete patched hardware suite.
- `/tmp/three-forward-hardware-control-full.json`: original-runtime control.
- `/tmp/three-forward-render-{control,patch}-r{1,2}.json`: images and write counts.
- `/tmp/three-forward-render-comparison.json`: assertions and exact comparisons.
- `/tmp/three-forward-{unit,render,compare}.mjs`: temporary browser/analysis tools.
- `/tmp/three-dynamic-{Attributes,BufferAttributeNode}.baseline.js`: control files.

Commands from the experiment worktree (temporary scripts use absolute paths):

```sh
PUPPETEER_EXECUTABLE_PATH=/tmp/cod-native-symbols/opt/google/chrome-beta/chrome npm test
PUPPETEER_EXECUTABLE_PATH=/tmp/cod-native-symbols/opt/google/chrome-beta/chrome npm run test-unit-addons
MESA_VK_DEVICE_SELECT=1002:7550! node /tmp/three-forward-unit.mjs /tmp/targeted.json Common
MESA_VK_DEVICE_SELECT=1002:7550! node /tmp/three-forward-unit.mjs /tmp/negative.json Common UnitTests.html --no-forward
MESA_VK_DEVICE_SELECT=1002:7550! node /tmp/three-forward-render.mjs patch /tmp/render.json
node /tmp/three-forward-compare.mjs
```

The stock unit runner splits query-string arguments on every `=`, so the separate
runner loads the unchanged test page with a correctly formed filter URL. No
production test-runner change was needed. These local rendering fixtures are not
a committed, portable examples screenshot harness, and do not establish desktop
performance or exhaustive application compatibility.
