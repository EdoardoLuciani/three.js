import Renderer from '../../../../../src/renderers/common/Renderer.js';
import NodeMaterial from '../../../../../src/materials/nodes/NodeMaterial.js';
import ProxyNodeMaterial from '../../../../../src/materials/nodes/ProxyNodeMaterial.js';
import NodeMaterialLoader from '../../../../../src/loaders/nodes/NodeMaterialLoader.js';
import ReferenceNode from '../../../../../src/nodes/accessors/ReferenceNode.js';
import { Material } from '../../../../../src/materials/Material.js';
import { Texture } from '../../../../../src/textures/Texture.js';
import { Fn, bool, float, uniform, vec3, vec4 } from '../../../../../src/Three.TSL.js';
import { generateCode } from '../../../tsl/code.js';

function getShadowNodes( material, cache = new WeakMap() ) {

	return Renderer.prototype._getShadowNodes.call( {
		_cacheShadowNodes: cache,
		shadowMap: { transmitted: true }
	}, material );

}

function descendants( node ) {

	const nodes = [];
	node.traverse( child => nodes.push( child ) );
	return nodes;

}

export default QUnit.module( 'Renderers', () => {

	QUnit.module( 'Common', () => {

		QUnit.module( 'Renderer shadow nodes', () => {

			QUnit.test( 'default, clone, serialization and proxy', ( assert ) => {

				const material = new NodeMaterial();
				assert.strictEqual( material.castShadowOpacityNode, null );
				assert.strictEqual( getShadowNodes( material ).colorNode, null );
				assert.strictEqual( getShadowNodes( new Material() ).colorNode, null );

				const opacity = float( 1 );
				material.castShadowOpacityNode = opacity;
				assert.strictEqual( material.clone().castShadowOpacityNode, opacity );
				const proxy = new ProxyNodeMaterial( material );
				assert.strictEqual( proxy.castShadowOpacityNode, opacity );
				assert.ok( descendants( getShadowNodes( proxy ).colorNode ).includes( opacity ) );

				const json = material.toJSON();
				assert.strictEqual( json.inputNodes.castShadowOpacityNode, opacity.uuid );
				const loaded = new NodeMaterialLoader()
					.setNodeMaterials( { NodeMaterial } )
					.setNodes( { [ opacity.uuid ]: opacity } )
					.parse( json );
				assert.strictEqual( loaded.castShadowOpacityNode, opacity );

			} );

			QUnit.test( 'default map and color alpha remain in the graph', ( assert ) => {

				const material = new NodeMaterial();
				material.map = new Texture();
				material.colorNode = vec4( 1, 1, 1, 0.5 );
				const original = descendants( getShadowNodes( material ).colorNode );
				assert.ok( original.some( node => node instanceof ReferenceNode && node.property === 'map' ) );
				assert.ok( original.includes( material.colorNode ) );

				material.castShadowOpacityNode = float( 1 );
				const explicit = descendants( getShadowNodes( material ).colorNode );
				assert.notOk( explicit.some( node => node instanceof ReferenceNode && node.property === 'map' ) );
				assert.notOk( explicit.includes( material.colorNode ) );
				assert.ok( explicit.includes( material.castShadowOpacityNode ) );

			} );

			QUnit.test( 'versioned replacement, reset and uniform updates', ( assert ) => {

				const material = new NodeMaterial();
				material.colorNode = vec4( 1, 1, 1, 0.5 );
				const cache = new WeakMap();
				const original = getShadowNodes( material, cache );
				assert.strictEqual( getShadowNodes( material, cache ), original );

				const opacity = uniform( 1 );
				material.castShadowOpacityNode = opacity;
				material.needsUpdate = true;
				const explicit = getShadowNodes( material, cache );
				assert.notStrictEqual( explicit, original );
				assert.ok( descendants( explicit.colorNode ).includes( opacity ) );
				opacity.value = 0.25;
				assert.strictEqual( getShadowNodes( material, cache ), explicit, 'Uniform changes retain the graph' );

				material.castShadowOpacityNode = null;
				material.needsUpdate = true;
				const reset = getShadowNodes( material, cache );
				assert.notStrictEqual( reset, explicit );
				assert.ok( descendants( reset.colorNode ).includes( material.colorNode ) );

			} );

			for ( const language of [ 'wgsl', 'glsl' ] ) {

				QUnit.module( language, () => {

					QUnit.test( 'explicit opacity does not build the source color graph', ( assert ) => {

						const material = new NodeMaterial();
						material.colorNode = Fn( () => {

							throw new Error( 'The overridden source color must not be built' );

						}, 'vec3' )();
						material.map = new Texture();
						material.castShadowOpacityNode = float( 1 );
						const code = generateCode( () => getShadowNodes( material ).colorNode, language );
						const expected = generateCode( () => vec4( vec3( 0 ), float( 1 ).mul( 1 ) ), language );
						assert.strictEqual( code, expected, 'Only the explicit opacity is built' );

					} );

					QUnit.test( 'default RGB color functions retain discard and other build effects', ( assert ) => {

						const material = new NodeMaterial();
						let builds = 0;
						material.colorNode = Fn( () => {

							builds ++;
							bool( true ).discard();
							return vec3( 1 );

						}, 'vec3' )();
						const code = generateCode( () => getShadowNodes( material ).colorNode, language );
						assert.strictEqual( builds, 1, 'RGB does not imply purity' );
						assert.ok( code.includes( 'discard' ) );

					} );

					QUnit.test( 'default cast-shadow and source color alpha are multiplied', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowNode = vec4( 0.2, 0.3, 0.4, 0.5 );
						material.colorNode = vec4( 1, 1, 1, 0.25 );
						assert.strictEqual(
							generateCode( () => getShadowNodes( material ).colorNode, language ),
							generateCode( () => vec4( material.castShadowNode.rgb, material.castShadowNode.a.mul( material.colorNode.a ) ), language )
						);

					} );

					QUnit.test( 'explicit zero opacity', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowOpacityNode = float( 0 );
						assert.strictEqual(
							generateCode( () => getShadowNodes( material ).colorNode, language ),
							generateCode( () => vec4( vec3( 0 ), float( 1 ).mul( 0 ) ), language )
						);

					} );

					QUnit.test( 'cast-shadow color and alpha still modulate explicit opacity', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowNode = vec4( 0.2, 0.3, 0.4, 0.5 );
						material.colorNode = vec4( 1, 1, 1, 0 );
						material.castShadowOpacityNode = float( 0.25 );
						assert.strictEqual(
							generateCode( () => getShadowNodes( material ).colorNode, language ),
							generateCode( () => vec4( material.castShadowNode.rgb, material.castShadowNode.a.mul( 0.25 ) ), language )
						);

					} );

					QUnit.test( 'shadow masks, depth and position overrides are retained', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowOpacityNode = float( 1 );
						material.maskNode = bool( true );
						material.maskShadowNode = bool( false );
						material.depthNode = float( 0.3 );
						material.positionNode = vec3( 1 );
						material.castShadowPositionNode = vec3( 2 );
						const nodes = getShadowNodes( material );
						assert.ok( generateCode( () => nodes.colorNode, language ).includes( 'discard' ) );
						assert.strictEqual( nodes.depthNode, material.depthNode );
						assert.strictEqual( nodes.positionNode, material.castShadowPositionNode );
						material.castShadowPositionNode = null;
						assert.strictEqual( getShadowNodes( material ).positionNode, material.positionNode );

					} );

					QUnit.test( 'cast-shadow effects are retained with explicit opacity', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowOpacityNode = float( 1 );
						material.castShadowNode = Fn( () => {

							bool( true ).discard();
							return vec4( 1 );

						} )();
						assert.ok( generateCode( () => getShadowNodes( material ).colorNode, language ).includes( 'discard' ) );

					} );

					QUnit.test( 'explicit opacity can include its own discard logic', ( assert ) => {

						const material = new NodeMaterial();
						material.castShadowOpacityNode = Fn( () => {

							bool( true ).discard();
							return float( 1 );

						} )();
						assert.ok( generateCode( () => getShadowNodes( material ).colorNode, language ).includes( 'discard' ) );

					} );

				} );

			}

		} );

	} );

} );
