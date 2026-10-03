import {
	Scene, OrthographicCamera, DirectionalLight, Mesh, PlaneGeometry,
	MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, RenderTarget, FloatType
} from 'three/webgpu';
import { getSharedRenderer } from './gpu-test-utils.js';

export default QUnit.module( 'TSL', () => {

	QUnit.module( 'PhysicalLightingModel', () => {

		for ( const backend of [ 'webgpu', 'webgl' ] ) {

			QUnit.test( `direct lighting respects specular intensity [${ backend }]`, async ( assert ) => {

				const renderer = await getSharedRenderer( backend );

				if ( renderer === null ) {

					assert.ok( true, `SKIPPED: "${ backend }" backend is not available in this environment.` );
					return;

				}

				const scene = new Scene();
				const camera = new OrthographicCamera( - 1, 1, 1, - 1, 0.1, 10 );
				const light = new DirectionalLight( 0xffffff, Math.PI );
				const material = new MeshPhysicalNodeMaterial( { roughness: 1 } );
				material.color.setScalar( 0.18 );
				const standard = new MeshStandardNodeMaterial( { roughness: 1 } );
				standard.color.copy( material.color );
				const geometry = new PlaneGeometry( 2, 2 );
				const mesh = new Mesh( geometry, material );
				scene.add( light, mesh );

				// Linear floating-point output, with no environment or postprocessing.
				const target = new RenderTarget( 1, 1, { type: FloatType, depthBuffer: false } );
				const previousTarget = renderer.getRenderTarget();
				const render = async ( mat = material ) => {

					mesh.material = mat;
					renderer.setRenderTarget( target );
					renderer.render( scene, camera );
					const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1 );

					return Array.from( pixels.slice( 0, 3 ) );

				};

				const close = ( actual, expected, message ) => {

					assert.ok( actual.every( ( value, i ) => Math.abs( value - expected[ i ] ) < 2e-6 ),
						`${ message }: expected ${ expected }, got ${ actual }` );

				};

				try {

					for ( const degrees of [ 0, 45, 75 ] ) {

						const angle = degrees * Math.PI / 180;
						const cos = Math.cos( angle ), sin = Math.sin( angle );
						camera.position.set( 2 * sin, 0, 2 * cos );
						camera.lookAt( 0, 0, 0 );

						// Opposite and same-side light/view directions exercise grazing
						// Fresnel in the ordinary and retroreflective lobes, respectively.
						for ( const side of [ - 1, 1 ] ) {

							light.position.set( side * 5 * sin, 0, 5 * cos );

							for ( const retroreflectivity of [ 0, 0.5, 1 ] ) {

								material.retroreflectivity = retroreflectivity;
								material.ior = 1.5;
								material.specularIntensity = 0;
								material.needsUpdate = true;
								const label = `${ degrees } degrees, light side ${ side }, retroreflectivity ${ retroreflectivity }`;

								// KHR_materials_specular: zero strength is pure Lambert diffuse.
								const diffuse = 0.18 * cos;
								close( await render(), [ diffuse, diffuse, diffuse ], `zero specular: ${ label }` );

								// IOR 1 isolates F90: F0 = 0, so multiscattering compensation = 1.
								// At roughness 1, D = 1/PI and V = 1/(4*cos). With light intensity
								// PI the complete specular output is F/4, not just an approximation
								// that omits the DFG compensation for nonzero F0.
								material.ior = 1;
								const schlick = x => 2 ** ( ( - 5.55473 * x - 6.98316 ) * x );
								const regular = schlick( side === - 1 ? cos : 1 );
								const retro = schlick( side === - 1 ? 1 : cos );

								for ( const intensity of [ 0.16, 1 ] ) {

									material.specularIntensity = intensity;
									const fresnel = intensity * ( regular * ( 1 - retroreflectivity ) + retro * retroreflectivity );
									const expected = diffuse * ( 1 - fresnel ) + fresnel / 4;
									close( await render(), [ expected, expected, expected ], `specular ${ intensity }: ${ label }` );

								}

							}

						}

						material.ior = 1.5;
						material.retroreflectivity = 0;
						material.specularIntensity = 1;
						material.needsUpdate = true;

						// Default physical materials retain standard material behavior.
						close( await render(), await render( standard ), `default dielectric: ${ degrees } degrees` );

						material.metalness = 1;
						standard.metalness = 1;
						close( await render(), await render( standard ), `default metal: ${ degrees } degrees` );

						for ( const retroreflectivity of [ 0, 1 ] ) {

							material.retroreflectivity = retroreflectivity;
							material.specularIntensity = 1;
							material.needsUpdate = true;
							const metal = await render();

							for ( const intensity of [ 0, 0.16 ] ) {

								material.specularIntensity = intensity;
								close( await render(), metal, `metal ignores specular ${ intensity }, retroreflectivity ${ retroreflectivity }: ${ degrees } degrees` );

							}

						}

						material.metalness = 0;
						standard.metalness = 0;

					}

				} finally {

					renderer.setRenderTarget( previousTarget );
					target.dispose();
					geometry.dispose();
					material.dispose();
					standard.dispose();

				}

			} );

		}

	} );

} );
