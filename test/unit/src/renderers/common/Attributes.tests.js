import Attributes from '../../../../../src/renderers/common/Attributes.js';
import WebGPUAttributeUtils from '../../../../../src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import BufferAttributeNode from '../../../../../src/nodes/accessors/BufferAttributeNode.js';
import NodeFrame from '../../../../../src/nodes/core/NodeFrame.js';
import { AttributeType } from '../../../../../src/renderers/common/Constants.js';
import { BufferAttribute } from '../../../../../src/core/BufferAttribute.js';
import { InterleavedBuffer } from '../../../../../src/core/InterleavedBuffer.js';
import { InterleavedBufferAttribute } from '../../../../../src/core/InterleavedBufferAttribute.js';
import { StaticDrawUsage, DynamicDrawUsage, StreamDrawUsage } from '../../../../../src/constants.js';

// Exercise the real WebGPU upload/range logic with a recording queue, without
// requiring a GPU device or changing renderer internals.
function createHarness() {

	const data = new WeakMap();
	const uploads = [];
	const nodeFrame = new NodeFrame();
	let creations = 0;
	const backend = {
		get( attribute ) {

			if ( ! data.has( attribute ) ) data.set( attribute, {} );
			return data.get( attribute );

		},
		getBufferAttribute( attribute ) {

			return attribute.isInterleavedBufferAttribute ? attribute.data : attribute;

		},
		createAttribute( attribute ) {

			creations ++;
			this.get( attribute ).buffer = {};

		},
		updateAttribute( attribute ) {

			utils.updateAttribute( attribute );

		},
		destroyAttribute() {},
		device: {
			queue: {
				writeBuffer( buffer, offset, array, start = 0, count = array.length - start ) {

					uploads.push( { buffer, offset, values: Array.from( array.slice( start, start + count ) ) } );

				}
			}
		}
	};
	const utils = new WebGPUAttributeUtils( backend );
	const attributes = new Attributes( backend, { createAttribute() {}, destroyAttribute() {} } );
	return {
		attributes, backend, uploads,
		get creations() {

			return creations;

		},
		update( attribute ) {

			attributes.update( backend.getBufferAttribute( attribute ), AttributeType.VERTEX );

		},
		updateNodes( nodes ) {

			// Match Renderer: all updateBefore callbacks precede geometry uploads.
			for ( const node of nodes ) nodeFrame.updateBeforeNode( node );
			for ( const node of nodes ) this.update( node.attribute );

		}
	};

}

function createMatrixNodes( source, usage = DynamicDrawUsage, stride = 16 ) {

	return [ 0, 4, 8, 12 ].map( offset => {

		const node = new BufferAttributeNode( source, 'vec4', stride, offset ).setUsage( usage );
		node.setup( { getDataFromNode: () => ( {} ), getTypeLength: () => 4 } );
		return node;

	} );

}

export default QUnit.module( 'Renderers', () => {

	QUnit.module( 'Common', () => {

		QUnit.module( 'Attributes', () => {

			for ( const usage of [ StaticDrawUsage, DynamicDrawUsage, StreamDrawUsage ] ) {

				QUnit.test( `unchanged attributes do not upload again (usage ${ usage })`, assert => {

					const harness = createHarness();
					const attribute = new BufferAttribute( new Float32Array( 8 ), 2 ).setUsage( usage );
					harness.update( attribute );
					harness.update( attribute );
					harness.update( attribute );
					assert.strictEqual( harness.creations, 1, 'The buffer is created once.' );
					assert.strictEqual( harness.uploads.length, 0, 'No update is requested without a version change.' );
					harness.attributes.dispose();

				} );

			}

			QUnit.test( 'dynamic attribute version changes upload once', assert => {

				const harness = createHarness();
				const attribute = new BufferAttribute( new Float32Array( [ 1, 2, 3, 4 ] ), 2 ).setUsage( DynamicDrawUsage );
				harness.update( attribute );
				attribute.array[ 0 ] = 9;
				attribute.needsUpdate = true;
				harness.update( attribute );
				harness.update( attribute );
				assert.strictEqual( harness.uploads.length, 1, 'One upload per published version.' );
				assert.deepEqual( harness.uploads[ 0 ].values, [ 9, 2, 3, 4 ], 'No ranges means a full upload.' );
				harness.attributes.dispose();

			} );

			QUnit.test( 'consumed dirty ranges do not cause a later full upload', assert => {

				const harness = createHarness();
				const attribute = new BufferAttribute( new Float32Array( [ 1, 2, 3, 4, 5, 6 ] ), 2 ).setUsage( DynamicDrawUsage );
				harness.update( attribute );
				attribute.array[ 2 ] = 30;
				attribute.array[ 3 ] = 40;
				attribute.addUpdateRange( 2, 2 );
				attribute.needsUpdate = true;
				harness.update( attribute );
				assert.deepEqual( attribute.updateRanges, [], 'The real backend consumes the ranges.' );
				assert.strictEqual( harness.uploads[ 0 ].offset, 8, 'Destination offset is in bytes.' );
				assert.deepEqual( harness.uploads[ 0 ].values, [ 30, 40 ], 'Only the dirty components are uploaded.' );
				harness.update( attribute );
				assert.strictEqual( harness.uploads.length, 1, 'No subsequent full-array upload.' );
				attribute.needsUpdate = true;
				harness.update( attribute );
				assert.deepEqual( harness.uploads[ 1 ].values, [ 1, 2, 30, 40, 5, 6 ], 'An explicit version without ranges still uploads everything.' );
				harness.attributes.dispose();

			} );

			QUnit.test( 'multiple dirty ranges upload once per version', assert => {

				const harness = createHarness();
				const attribute = new BufferAttribute( new Float32Array( [ 1, 2, 3, 4, 5, 6 ] ), 2 ).setUsage( DynamicDrawUsage );
				harness.update( attribute );
				attribute.addUpdateRange( 0, 1 );
				attribute.addUpdateRange( 4, 2 );
				attribute.needsUpdate = true;
				harness.update( attribute );
				harness.update( attribute );
				assert.deepEqual( harness.uploads.map( upload => [ upload.offset, upload.values ] ), [[ 0, [ 1 ]], [ 16, [ 5, 6 ]]] );
				harness.attributes.dispose();

			} );

			QUnit.test( 'interleaved views share version tracking across repeated passes', assert => {

				const harness = createHarness();
				const buffer = new InterleavedBuffer( new Float32Array( [ 1, 2, 3, 4, 5, 6, 7, 8 ] ), 4 ).setUsage( DynamicDrawUsage );
				const position = new InterleavedBufferAttribute( buffer, 2, 0 );
				const uv = new InterleavedBufferAttribute( buffer, 2, 2 );
				harness.update( position );
				harness.update( uv );
				buffer.array[ 0 ] = 9;
				buffer.addUpdateRange( 0, 2 );
				buffer.needsUpdate = true;
				for ( let pass = 0; pass < 3; pass ++ ) {

					harness.update( position );
					harness.update( uv );

				}

				assert.strictEqual( harness.creations, 1, 'One allocation for the shared backing buffer.' );
				assert.strictEqual( harness.uploads.length, 1, 'Views/passes do not multiply uploads.' );
				assert.deepEqual( harness.uploads[ 0 ].values, [ 9, 2 ] );
				harness.attributes.delete( buffer );
				harness.attributes.dispose();

			} );

			// Compatibility guard: matrix attribute nodes use internal interleaved
			// views. Removing automatic uploads must not lose an explicit source update.
			QUnit.test( 'matrix attribute nodes respect source needsUpdate', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 16 ), 16 ).setUsage( DynamicDrawUsage );
				const nodes = createMatrixNodes( source );
				harness.updateNodes( nodes );
				source.array[ 12 ] = 3;
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				assert.strictEqual( harness.uploads.length, 1, 'Publishing a source version must upload the wrapped matrix data.' );
				assert.strictEqual( harness.uploads[ 0 ]?.values[ 12 ], 3, 'The published translation reaches the GPU upload.' );
				harness.updateNodes( nodes );
				assert.strictEqual( harness.uploads.length, 1, 'An unchanged matrix is not uploaded again.' );
				assert.ok( nodes.every( node => node.attribute.data === nodes[ 0 ].attribute.data ), 'All columns share one backing buffer.' );
				harness.attributes.delete( nodes[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'matrix ranges are consumed once and multiple same-frame versions are honored', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 16 ), 16 );
				const nodes = createMatrixNodes( source, StaticDrawUsage );
				harness.updateNodes( nodes );
				source.array[ 12 ] = 3;
				source.addUpdateRange( 12, 1 );
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				assert.deepEqual( source.updateRanges, [], 'The upload consumes the original source ranges.' );
				source.array[ 13 ] = 4;
				source.addUpdateRange( 13, 1 );
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				harness.updateNodes( nodes );
				assert.deepEqual( harness.uploads.map( upload => [ upload.offset, upload.values ] ), [[ 48, [ 3 ]], [ 52, [ 4 ]]] );
				harness.attributes.delete( nodes[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'matrix ranges remain pending until the geometry upload', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 16 ), 16 );
				const nodes = createMatrixNodes( source );
				harness.updateNodes( nodes );
				source.array[ 12 ] = 3;
				source.addUpdateRange( 12, 1 );
				source.needsUpdate = true;
				new NodeFrame().updateBeforeNode( nodes[ 0 ] );
				assert.strictEqual( source.updateRanges.length, 1, 'A column callback must not consume the source ranges.' );
				source.array[ 13 ] = 4;
				source.addUpdateRange( 13, 1 );
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				assert.deepEqual( harness.uploads.map( upload => [ upload.offset, upload.values ] ), [[ 48, [ 3 ]], [ 52, [ 4 ]]] );
				harness.attributes.delete( nodes[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'independent matrix owners do not share version state through an aliased array', assert => {

				const harness = createHarness();
				const array = new Float32Array( 16 );
				const sourceA = new BufferAttribute( array, 16 );
				const sourceB = new BufferAttribute( array, 16 );
				const nodesA = createMatrixNodes( sourceA );
				const nodesB = createMatrixNodes( sourceB );
				harness.updateNodes( [ ...nodesA, ...nodesB ] );
				assert.notStrictEqual( nodesA[ 0 ].attribute.data, nodesB[ 0 ].attribute.data );
				array[ 12 ] = 3;
				sourceA.needsUpdate = true;
				harness.updateNodes( [ ...nodesA, ...nodesB ] );
				assert.strictEqual( harness.uploads.length, 1, 'Only the published owner is uploaded.' );
				sourceB.needsUpdate = true;
				harness.updateNodes( nodesB );
				assert.strictEqual( harness.uploads.length, 2, 'The second owner has its own residency.' );
				harness.attributes.delete( nodesA[ 0 ].attribute.data );
				harness.attributes.delete( nodesB[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'different matrix strides retain separate views and upload state', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 32 ), 16 );
				const nodesA = createMatrixNodes( source );
				const nodesB = createMatrixNodes( source, DynamicDrawUsage, 8 ).slice( 0, 2 );
				harness.updateNodes( [ ...nodesA, ...nodesB ] );
				assert.notStrictEqual( nodesA[ 0 ].attribute.data, nodesB[ 0 ].attribute.data );
				assert.strictEqual( nodesA[ 0 ].attribute.data.stride, 16 );
				assert.strictEqual( nodesB[ 0 ].attribute.data.stride, 8 );
				source.array[ 12 ] = 3;
				source.addUpdateRange( 12, 1 );
				source.needsUpdate = true;
				harness.updateNodes( [ ...nodesA, ...nodesB ] );
				assert.strictEqual( harness.uploads.length, 2, 'Both backing buffers receive the changed data.' );
				harness.updateNodes( [ ...nodesA, ...nodesB ] );
				assert.strictEqual( harness.uploads.length, 2, 'Neither buffer uploads unchanged data.' );
				harness.attributes.delete( nodesA[ 0 ].attribute.data );
				harness.attributes.delete( nodesB[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'mat3 column views forward partial source updates', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 9 ), 9 );
				const nodes = [ 0, 3, 6 ].map( offset => {

					const node = new BufferAttributeNode( source, 'vec3', 9, offset );
					node.setup( { getDataFromNode: () => ( {} ), getTypeLength: () => 3 } );
					return node;

				} );
				harness.updateNodes( nodes );
				source.array[ 6 ] = 3;
				source.addUpdateRange( 6, 1 );
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				harness.updateNodes( nodes );
				assert.strictEqual( harness.uploads.length, 1 );
				assert.strictEqual( harness.uploads[ 0 ]?.offset, 24 );
				assert.deepEqual( harness.uploads[ 0 ]?.values, [ 3 ] );
				harness.attributes.delete( nodes[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'matrix wrappers follow same-size source array replacement', assert => {

				const harness = createHarness();
				const source = new BufferAttribute( new Float32Array( 16 ), 16 );
				const nodes = createMatrixNodes( source );
				harness.updateNodes( nodes );
				source.array = new Float32Array( 16 );
				source.array[ 12 ] = 9;
				source.needsUpdate = true;
				harness.updateNodes( nodes );
				assert.strictEqual( nodes[ 0 ].attribute.data.array, source.array );
				assert.strictEqual( harness.uploads[ 0 ]?.values[ 12 ], 9 );
				harness.attributes.delete( nodes[ 0 ].attribute.data );
				harness.attributes.dispose();

			} );

			QUnit.test( 'a deleted allocation is recreated at the same source version', assert => {

				const harness = createHarness();
				const attribute = new BufferAttribute( new Float32Array( 8 ), 2 ).setUsage( DynamicDrawUsage );
				harness.update( attribute );
				const generation = harness.attributes.get( attribute ).generation;
				harness.attributes.delete( attribute );
				harness.update( attribute );
				assert.strictEqual( harness.creations, 2 );
				assert.notStrictEqual( harness.attributes.get( attribute ).generation, generation, 'A new GPU allocation gets a new generation.' );
				harness.attributes.dispose();

			} );

		} );

	} );

} );
