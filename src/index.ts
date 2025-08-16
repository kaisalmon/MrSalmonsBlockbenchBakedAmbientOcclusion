import {
	MeshBVH,
} from 'three-mesh-bvh';

declare const THREE: typeof import('three');
interface Color {
    r: number;
    g: number;
    b: number;
    a: number;
}

interface VectorPool {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    normal: THREE.Vector3;
}

interface ProcessCallback {
    (missing: boolean, withTextures: boolean, processedPixels: number): void;
}

let button: Action;

/* #fffa88bb */
const HIGHLIGHT_COLOR: Color = {
    r: 231,
    g: 225,
    b: 164,
    a: 0.4
};

const SHADOW_COLOR: Color = {
    r: 36,
    g: 11,
    b: 55,
    a: 0.5
};

const SAMPLES: number = 1000;

(Plugin as any).register('blockbench-baked-ao', {
    title: 'Blockbench Baked AO',
    author: 'Kai Salmon',
    icon: 'icon',
    description: 'Baked Ambient Occlusion for Blockbench',
    version: '1.0.0',
    variant: 'both',
    onload(): void {
        button = new Action('bake_ambient_occlusion', {
            name: 'Bake Ambient Occlusion',
            description: 'Perform ambient occlusion baking on selected meshes',
            icon: 'cake',
            click: async function(): Promise<void> {
                
                if (Mesh.selected.length === 0) {
                    Blockbench.showToastNotification({
                        text: 'No meshes selected',
                    });
                    return;
                }
                
                let anyMissing: boolean = false;
                let anyWithTextures: boolean = false;
                let pixelCount: number = 0;
                
                // Show progress notification
                Blockbench.showToastNotification({
                    text: 'Starting ambient occlusion baking...',
                });
                
                performance.mark("startAO");

                for (const mesh of Mesh.selected) {
                    let hasSelectedFaces: boolean = false;
                    mesh.forAllFaces((face: MeshFace) => {
                        if (face.isSelected()) {
                            hasSelectedFaces = true;
                        }
                    });
                    
                    // Process each face
                    await processMeshFaces(mesh, hasSelectedFaces, (missing: boolean, withTextures: boolean, processedPixels: number) => {
                        anyMissing = anyMissing || missing;
                        anyWithTextures = anyWithTextures || withTextures;
                        pixelCount += processedPixels;
                    });
                }
                
                performance.mark("endAO");
                const measure: PerformanceMeasure = performance.measure("AO Processing Time", "startAO", "endAO");
                console.log(`AO Processing Time: ${measure.duration}ms`);
                
                if (!anyWithTextures) {
                    Blockbench.showToastNotification({
                        text: 'No textures found on selected meshes',
                    });
                } else if (anyMissing) {
                    Blockbench.showToastNotification({
                        text: 'Some faces are missing textures',
                    });
                } else {
                    Blockbench.showToastNotification({
                        text: `Done! Processed ${pixelCount} pixels.`,
                    });
                }
                
            }
        });
        MenuBar.addAction(button, 'filter');
    },
    onunload(): void {
        button.delete();
    }
});

/**
 * Process all faces of a mesh asynchronously
 * @param mesh - The mesh to process
 * @param hasSelectedFaces - Whether the mesh has selected faces
 * @param callback - Callback to report progress
 */
async function processMeshFaces(mesh: Mesh, hasSelectedFaces: boolean, callback: ProcessCallback): Promise<void> {
    let anyMissing: boolean = false;
    let anyWithTextures: boolean = false;
    let totalPixelsProcessed: number = 0;
    
    const faces: MeshFace[] = [];
    mesh.forAllFaces((face: MeshFace) => faces.push(face));
    
    const cache: Record<string, boolean> = {}; 
    const [lowestY, highestY]: [number, number] = getHighestAndLowestY(mesh);
    
    const groundPlane: THREE.Mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1000, 1000),
        new THREE.MeshBasicMaterial({
            color: 0x000000, 
            side: THREE.FrontSide, 
            transparent: true, 
            opacity: 0.5
        })
    );

    groundPlane.rotation.set(-Math.PI / 2, 0, 0); // Rotate to be horizontal
    groundPlane.position.setY(lowestY - 1);
    groundPlane.updateMatrix();
    groundPlane.updateWorldMatrix(false, false);

    const geometry: THREE.BufferGeometry = (mesh.mesh as THREE.Mesh).geometry;
    const bvh: MeshBVH = new MeshBVH(geometry);

    for (const face of faces) {
        const tex: Texture | undefined = face.getTexture();
        if (!tex) {
            anyMissing = true;
            continue;
        }
        
        if (hasSelectedFaces && !face.isSelected()) continue;
        
        anyWithTextures = true;
        const pixelsProcessed: number = await processFaceTexture(tex, face, mesh, cache, groundPlane, bvh);
        totalPixelsProcessed += pixelsProcessed;
    }
    
    callback(anyMissing, anyWithTextures, totalPixelsProcessed);
}

/**
 * Process a single face's texture asynchronously
 * @param tex - The texture to edit
 * @param face - The face being processed
 * @param mesh - The mesh containing the face
 * @param cache - Cache to avoid reprocessing pixels
 * @param groundPlane - Ground plane for ambient occlusion calculations
 * @returns Number of pixels processed
 */
async function processFaceTexture(
    tex: Texture, 
    face: MeshFace, 
    mesh: Mesh, 
    cache: Record<string, boolean>, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH,
): Promise<number> {
    await new Promise(resolve => setTimeout(resolve, 0));
    let processedPixels: number = 0;
    tex.edit((htmlCanvasElement: HTMLCanvasElement) => {
        const ctx: CanvasRenderingContext2D = htmlCanvasElement.getContext('2d')!;
        const occupationMatrix: Record<string, Record<string, boolean>> = face.getOccupationMatrix();
        
        
        // Collect all pixel coordinates first
        const pixelCoords: [number, number][] = [];
        Object.keys(occupationMatrix).forEach((uStr: string) => {
            Object.keys(occupationMatrix[uStr]).forEach((vStr: string) => {
                const value: boolean = occupationMatrix[uStr][vStr];
                if (value === true) {
                    pixelCoords.push([parseInt(uStr, 10), parseInt(vStr, 10)]);
                }
            });
        });
        
        // Process pixels in batches
        const getKey = (u: number, v: number): string => `${u},${v}`;
        
        for (const [u, v] of pixelCoords) {
            const key: string = getKey(u, v);
            if (cache[key]) {
                continue;
            }
            
            // Get x,y,z in 3d space of the face at this u,v
            const {x, y, z} = face.UVToLocal([u + 0.5, v + 0.5]);
            const [r, g, b, a]: [number, number, number, number] = calculateAmbientOcclusion([x, y, z], [u, v], face, mesh, groundPlane, bvh);

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(u, v, 1, 1);
            processedPixels++;
            cache[key] = true; // Mark this pixel as processed
        }
            
    });
    return processedPixels;
}

const vectorPool: VectorPool = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    normal: new THREE.Vector3()
};

/**
 * Calculates ambient occlusion at a specific point on a mesh face
 * @param position - The [x,y,z] position in 3D space
 * @param uv - The [u,v] texture coordinates
 * @param face - The face being processed
 * @param mesh - The mesh containing the face
 * @param groundPlane - Ground plane for occlusion calculations
 * @returns RGBA values [r,g,b,a] for the ambient occlusion
 */
function calculateAmbientOcclusion(
    position: [number, number, number], 
    uv: [number, number], 
    face: MeshFace, 
    mesh: Mesh, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH
): [number, number, number, number] {
    const [x, y, z]: [number, number, number] = position;
    const [normalX, normalY, normalZ]: [number, number, number] = face.getNormal(true);
    
    // Reuse pooled vectors
    vectorPool.normal.set(normalX, normalY, normalZ);
    
    let occlusion: number = 0;
    const length: number = 8;
    const rayCount: number = SAMPLES;
    
    for (let i: number = 0; i < rayCount; i++) {
        // Reuse origin vector
        vectorPool.origin.set(x, y, z)
            .addScaledVector(vectorPool.normal, 0.5);
        vectorPool.origin.x += (Math.random() - 0.5);
        vectorPool.origin.y += (Math.random() - 0.5);
        vectorPool.origin.z += (Math.random() - 0.5);
        
        // Reuse direction vector
        vectorPool.direction.set(
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2
        ).normalize();
        const raycaster: THREE.Raycaster = new THREE.Raycaster(vectorPool.origin, vectorPool.direction, 0.001, length);
        // const intersects: THREE.Intersection[] = ray.intersectObjects([mesh.mesh, groundPlane]);
        
        const invMat: THREE.Matrix4 =  (mesh.mesh as THREE.Mesh).matrixWorld.clone().invert();

        // raycasting
        // ensure the ray is in the local space of the geometry being cast against
        raycaster.ray.applyMatrix4( invMat );
        const hit = bvh.raycastFirst( raycaster.ray );
        if (hit) {
            occlusion += 1;
        }else{
            // Check if the ray intersects the ground plane
            const groundPlaneHit = raycaster.intersectObject(groundPlane).length > 0;
            if (groundPlaneHit) {
                occlusion += 1;
            }
        }
    }

    let occlusionFactor: number = 1 - occlusion / rayCount;

    let t: number;
    let color: Color;
    
    if (occlusionFactor < 0.5) {
        t = (0.5 - occlusionFactor) * 2;
        const shadowGamma: number = 1.0;
        t = Math.pow(t, shadowGamma);
        color = SHADOW_COLOR;
    } else {
        t = (occlusionFactor - 0.5) * 2;
        const highlightGamma: number = 0.5;
        t = Math.pow(t, highlightGamma);
        color = HIGHLIGHT_COLOR;
    }
    
    return [
        color.r,
        color.g,
        color.b,
        color.a * t
    ];
}

function lerp(a: number, b: number, t: number): number {
    return a * (1 - t) + b * t;
}

/**
 * Get the highest and lowest Y coordinates of all vertices in a mesh
 * @param mesh - The mesh to analyze
 * @returns [lowestY, highestY]
 */
function getHighestAndLowestY(mesh: Mesh): [number, number] {
    
    if (!mesh.mesh || !(mesh.mesh instanceof THREE.Mesh)) {
        console.log(mesh);
        throw new Error('Invalid mesh object');
    }
    
    const geometry = mesh.mesh.geometry;
    
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
        console.log(geometry);
        throw new Error('Mesh does not have valid geometry attributes');
    }
    
    const positionAttribute: THREE.BufferAttribute = geometry.attributes.position as THREE.BufferAttribute;
    let highestY: number = -Infinity;
    let lowestY: number = Infinity;
    
    for (let i: number = 0; i < positionAttribute.count; i++) {
        const y: number = positionAttribute.getY(i);
        if (y > highestY) highestY = y;
        if (y < lowestY) lowestY = y;
    }
    
    return [lowestY, highestY];
}