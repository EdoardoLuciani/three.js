# Local experiment: version-driven dynamic attribute uploads

## Scope

Base: fork `origin/dev`, `0978e2b62e53654ebe1a2c3032ebee0a4981c701`.
Branch: `experiment/versioned-dynamic-attributes`.

The only runtime change is deleting `|| attribute.usage === DynamicDrawUsage`
from `src/renderers/common/Attributes.js` and removing its unused import. No new
update policy, source-version forwarding, renderer hooks, or game changes were
added. Nine focused QUnit tests and this experiment record accompany it.

**Result: useful for ordinary versioned attributes, but the deletion alone is
not a compatibility-complete fix. A real matrix-attribute regression remains.**
No tests were disabled or changed to accept the regression. This is a local
experiment, not a merge-ready patch or an upstream submission.

## Test results

Clean `PUPPETEER_SKIP_DOWNLOAD=1 npm ci`: passed, no vulnerabilities reported.
Browser: temporary official Chrome Beta 153.0.8010.12.

### Existing suite

The unmodified base's `npm test` already failed three core tests in its default
software-GPU configuration:

- `textureBarrier`: unsupported RGBA32Float read/write storage texture access.
- WebGL `triNoise3D` deterministic-output assertion.
- WebGL negative-operand integer `mod` assertions.

The final patched suite has 1,977 core tests: 1,972 passed, one TODO, four failed.
Three failures are the same baseline failures; the additional failure is the new
matrix-attribute compatibility regression below. Since `npm test` stops at core
failure, add-ons were run separately: **116 passed** on both baseline and patch.

A separate runner also ran the full, unchanged test page using hardware AMD
RDNA-4 WebGPU (nonfallback). Both versions have existing subgroupBallot assertions
that assume <=32 lanes, while this adapter uses 64, and the same WebGL `mod`
failure. The final patch has **1,973 passed, one TODO, three failed**: those two
existing failures and the new matrix compatibility failure. The control with the
same nine new tests has 1,969 passed, one TODO, seven failed: five deliberately
new upload-suppression assertions fail against the old policy, plus the two
existing failures. Its matrix compatibility test passes.

`npm run build`, source/test ESLint, and `git diff --check`: passed. Generated
build output was restored after validation and is not part of the change.
The complete examples screenshot suite was not run.

### Focused tests

| Test group | Original runtime | Deletion-only runtime |
| --- | --- | --- |
| Eight versioning/range/allocation tests | 3 pass, 5 fail | **8 pass** |
| Matrix BufferAttribute node source-version compatibility | **Pass** | **Fail** |

The tests use actual `Attributes`, `WebGPUAttributeUtils`, and, for the matrix
case, `BufferAttributeNode`, with a recording queue. They cover unchanged static,
dynamic and stream attributes; full and partial dirty uploads; range consumption;
multiple ranges; shared interleaved views across repeated updates; and allocation
recreation. The compatibility guard remains a normal failing `QUnit.test`, not a
TODO or a weakened assertion.

## Paired hardware-WebGPU rendering

A separate fixture rendered actual scenes into 32x32 render targets and read back
all RGBA bytes. Two independent control/patch pairs were run; every run selected
nonfallback AMD RDNA-4 WebGPU with no page errors or console errors. The control
serves the exact original `Attributes.js` before module loading; all other source
files are identical. Only public WebGPU calls are wrapped for diagnostic counts.

Seven versioned cases produced **zero byte differences across 245,760 paired
image bytes**, with non-vacuous visible geometry/color changes:

- Ordinary dynamic geometry: full updates, partial updates, and a second camera.
- Dynamic interleaved positions/colors.
- Instancing with capacity 1 (matrix UBO path).
- Instancing with capacity 4,097 (matrix vertex-attribute path).
- Real shadow and beauty passes sharing dynamic geometry.
- TSL dynamic attributes backed by an application-owned `InterleavedBuffer`.
- TSL dynamic attributes backed directly by a vec3 `BufferAttribute`.

Representative unchanged-buffer writes per fixture stage:

| Path | Control | Patch |
| --- | ---: | ---: |
| Ordinary dynamic position attribute | 1 | 0 |
| Dynamic interleaved buffer | 1 | 0 |
| Large-capacity instanced matrices/colors | 2 | 0 |
| Shadow + beauty position buffer | 2 | 0 |

A changed position buffer shared by shadow and beauty updates once instead of
twice, with identical captured output. The small-instancing UBO upload remains:
this experiment does not address unversioned raw uniform buffers or bone uploads.
These are diagnostic counts, not speedup/FPS measurements.

## Confirmed compatibility failures

### 1. Matrix TSL attributes lose even explicitly published source updates

The fixture supplies three per-vertex matrices through:

```js
const source = new BufferAttribute( matrices, 16 ).setUsage( DynamicDrawUsage );
const transform = dynamicBufferAttribute( source, 'mat4' );
material.positionNode = transform.mul( vec4( positionLocal, 1 ) ).xyz;

// After initial rendering:
// ...change the matrices...
source.needsUpdate = true;
```

The control moves the triangle; the patch leaves its initial position unchanged.
The same result occurs in both pairs, with 1,014 differing image bytes each time.
The patch issues no matrix upload even though `source.version` increments.

Reason: `createBufferAttribute()` splits a mat4 into vec4 attribute nodes.
`BufferAttributeNode` only directly preserves BufferAttributes with itemSize <=4.
Larger sources go through `_getBufferAttribute(source.array, stride)`, which
creates an internal `InterleavedBuffer`. The original source version is not
forwarded to that internal buffer. Previously, DynamicDrawUsage forced its upload
and masked the missing propagation. Removing the OR exposes it.

This finding is specific to matrix wrappers. Direct vec3 BufferAttributes retain
their original identity/version and passed the rendered update test. The current
InstancedMesh helper has separate version forwarding and also passed.

### 2. Raw TypedArray automatic updates stop

`dynamicBufferAttribute( typedArray, 'vec3' )` currently uploads subsequent raw
array mutations without a published attribute version. The control updates; the
patch freezes the original data. Again, both pairs show 1,014 differing bytes.
This is the expected behavior change when removing automatic updating, but it
needs an explicit API-compatibility decision, not silent treatment as a bug fix.

## Assessment

The version-driven rule is a reasonable simplification, but **the bare deletion
cannot yet be called generally correct**. At minimum, matrix source-version
forwarding needs a correctness fix; it is not merely a future optimization. Raw
TypedArray automatic-update compatibility also needs a deliberate decision.
Keep these findings separate from any broader resource pooling/update redesign.

Prior art: Three.js PRs [#28697](https://github.com/mrdoob/three.js/pull/28697),
[#28704](https://github.com/mrdoob/three.js/pull/28704),
[#28716](https://github.com/mrdoob/three.js/pull/28716), and
[#26057](https://github.com/mrdoob/three.js/pull/26057).

## Local evidence and reproduction

Primary artifacts:

- `/tmp/three-dynamic-baseline-test.log`: original core suite, before adding tests.
- `/tmp/three-dynamic-patched-test-final.log`: final default suite.
- `/tmp/three-dynamic-{baseline,patched}-addons.log`: complete add-on results.
- `/tmp/three-dynamic-{control,patched}-hw-final.json`: full hardware test results.
- `/tmp/three-dynamic-regression-{before,after}-final.json`: focused results.
- `/tmp/three-dynamic-render-{control,patch}-r{1,2}.json`: all fixture images/counts.
- `/tmp/three-dynamic-render-comparison.json`: exact paired comparisons.
- `/tmp/three-dynamic-unit.mjs`, `/tmp/three-dynamic-render.mjs`, and
  `/tmp/three-dynamic-compare.mjs`: local browser/aggregation scripts.
- `/tmp/three-dynamic-Attributes.baseline.js`: original runtime control source.

Examples (scripts use local absolute paths):

```sh
PUPPETEER_EXECUTABLE_PATH=/tmp/cod-native-symbols/opt/google/chrome-beta/chrome npm test
MESA_VK_DEVICE_SELECT=1002:7550! node /tmp/three-dynamic-unit.mjs /tmp/targeted.json Common
MESA_VK_DEVICE_SELECT=1002:7550! node /tmp/three-dynamic-render.mjs patch /tmp/render.json
node /tmp/three-dynamic-compare.mjs
```

Initial filtered invocations of the stock unit runner produced no tests because
its CLI splits the testPage argument on every `=`, truncating a query-string
filter. The separate runner uses the same test page with a correctly formed URL;
no production test-runner change was needed. An initial fixture favicon 404 was
fixed by serving an empty favicon; the four final captures have zero errors.
