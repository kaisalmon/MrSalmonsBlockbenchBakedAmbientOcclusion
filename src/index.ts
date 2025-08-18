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

interface PixelResult {
    color: [number, number, number, number];
    backfaceRatio: number;
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
const RETAIN_TEXTURE_TRANSPARENCY: boolean = true;

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
                    const result = await processMeshFaces(mesh, hasSelectedFaces);
                    anyMissing = anyMissing || result.anyMissing;
                    anyWithTextures = anyWithTextures || result.anyWithTextures;
                    pixelCount += result.totalPixelsProcessed;
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

interface ProcessMeshFacesResult {
    anyMissing: boolean;
    anyWithTextures: boolean;
    totalPixelsProcessed: number;
}
/**
 * Process all faces of a mesh asynchronously
 * @param mesh - The mesh to process
 * @param hasSelectedFaces - Whether the mesh has selected faces
 * @param callback - Callback to report progress
 */
async function processMeshFaces(mesh: Mesh, hasSelectedFaces: boolean): Promise<ProcessMeshFacesResult> {
    let anyMissing: boolean = false;
    let anyWithTextures: boolean = false;
    let totalPixelsProcessed: number = 0;
    
    const faces: MeshFace[] = [];
    mesh.forAllFaces((face: MeshFace) => faces.push(face));
    
    // Group faces by texture
    const facesByTexture: Map<Texture, MeshFace[]> = new Map();
    
    for (const face of faces) {
        const tex: Texture | undefined = face.getTexture();
        if (!tex) {
            anyMissing = true;
            continue;
        }
        
        if (hasSelectedFaces && !face.isSelected()) continue;
        
        anyWithTextures = true;
        
        if (!facesByTexture.has(tex)) {
            facesByTexture.set(tex, []);
        }
        facesByTexture.get(tex)!.push(face);
    }
    
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
    console.log(`Lowest Y: ${lowestY}, Highest Y: ${highestY}`);
    groundPlane.rotation.set(-Math.PI / 2, 0, 0); // Rotate to be horizontal
    groundPlane.position.setY(lowestY - 1);
    groundPlane.updateMatrix();
    groundPlane.updateWorldMatrix(false, false);

    const geometry: THREE.BufferGeometry = (mesh.mesh as THREE.Mesh).geometry;
    const geometryBackup = geometry.clone(); // Backup as BVH mutates the geometry in a way that causes bugs in Blockbench
    const bvh: MeshBVH = new MeshBVH(geometry, {
        indirect: true,
    });
    
    try {
        // Process each texture
        for (const [texture, textureFaces] of facesByTexture) {
            const pixelsProcessed: number = await processTextureWithFaces(texture, textureFaces, mesh, groundPlane, bvh);
            totalPixelsProcessed += pixelsProcessed;
        }

        return { anyMissing, anyWithTextures, totalPixelsProcessed };
    } finally {
        (mesh.mesh as THREE.Mesh).geometry = geometryBackup;
    }
}

/**
 * Process all faces that use a specific texture
 * @param texture - The texture to edit
 * @param faces - All faces that use this texture
 * @param mesh - The mesh containing the faces
 * @param groundPlane - Ground plane for ambient occlusion calculations
 * @param bvh - BVH for raycasting
 * @returns Number of pixels processed
 */
async function processTextureWithFaces(
    texture: Texture, 
    faces: MeshFace[], 
    mesh: Mesh, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH,
): Promise<number> {
    
    // Track best result for each pixel
    const bestResults: Map<string, PixelResult> = new Map();
    
    // Calculate ambient occlusion for all face/pixel combinations
    for (const face of faces) {
        const occupationMatrix: Record<string, Record<string, boolean>> = face.getOccupationMatrix();
        
        // Collect all pixel coordinates for this face
        const pixelCoords: [number, number][] = [];
        Object.keys(occupationMatrix).forEach((uStr: string) => {
            Object.keys(occupationMatrix[uStr]).forEach((vStr: string) => {
                const value: boolean = occupationMatrix[uStr][vStr];
                if (value === true) {
                    pixelCoords.push([parseInt(uStr, 10), parseInt(vStr, 10)]);
                }
            });
        });
        
        let i = 0;
        // Process pixels for this face
        for (const [u, v] of pixelCoords) {
            const key: string = `${u},${v}`;
            
            // Get x,y,z in 3d space of the face at this u,v
            const {x, y, z} = face.UVToLocal([u + 0.5, v + 0.5]);
            const result = calculateAmbientOcclusion([x, y, z], [u, v], face, mesh, groundPlane, bvh);

            if (result) {
                const [color, backfaceRatio] = result;
                
                // Check if this is the best result for this pixel so far
                const existing = bestResults.get(key);
                if (!existing || backfaceRatio < existing.backfaceRatio) {
                    bestResults.set(key, {
                        color: color,
                        backfaceRatio: backfaceRatio
                    });
                }
            }

            i++;
            if (i % 32 === 0) {
                // Yield to allow UI updates
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }
    
    // Apply all results in a single edit session
    let processedPixels: number = 0;
    texture.edit((htmlCanvasElement: HTMLCanvasElement) => {
        const ctx: CanvasRenderingContext2D = htmlCanvasElement.getContext('2d')!;
        
        for (const [pixelKey, result] of bestResults) {
            const [u, v] = pixelKey.split(',').map(x => parseInt(x, 10));
            let [r, g, b, a] = result.color;

            if (RETAIN_TEXTURE_TRANSPARENCY) {
                const srcAlpha = ctx.getImageData(u, v, 1, 1).data[3];
                a *= srcAlpha / 255;
            }

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(u, v, 1, 1);
            processedPixels++;
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
 * @param bvh - BVH for raycasting
 * @returns [RGBA values, backface ratio] for the ambient occlusion, or null if backface ratio > 25%
 */
function calculateAmbientOcclusion(
    position: [number, number, number], 
    uv: [number, number], 
    face: MeshFace, 
    mesh: Mesh, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH
): [[number, number, number, number], number] | null {
    const [x, y, z]: [number, number, number] = position;
    const [normalX, normalY, normalZ]: [number, number, number] = face.getNormal(true);
    
    // Reuse pooled vectors
    vectorPool.normal.set(normalX, normalY, normalZ);
    
    let occlusion: number = 0;
    let backfaceHits: number = 0;
    const length: number = 8;
    const rayCount: number = SAMPLES;

    for (let i: number = 0; i < rayCount; i++) {
        // Reuse origin vector
        vectorPool.origin.set(x, y, z)
            .addScaledVector(vectorPool.normal, 0.5);
        vectorPool.origin.x += (Math.random() - 0.5) * 0.5
        vectorPool.origin.y += (Math.random() - 0.5) * 0.5;
        vectorPool.origin.z += (Math.random() - 0.5) * 0.5;
        
        // Reuse direction vector
        vectorPool.direction.set(
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2,
            (Math.random() - 0.5) * 2
        ).normalize();
        const raycaster: THREE.Raycaster = new THREE.Raycaster(vectorPool.origin, vectorPool.direction, 0.001, length);
        
        const invMat: THREE.Matrix4 =  (mesh.mesh as THREE.Mesh).matrixWorld.clone().invert();

        raycaster.ray.applyMatrix4( invMat );
        const hit = bvh.raycastFirst( raycaster.ray, THREE.DoubleSide );
        if (hit) {
            const faceNormal = hit.face!.normal!;
            const dot = vectorPool.direction.dot(faceNormal);
            if (dot > 0) {
                backfaceHits += 1;
            }
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
    const backfaceRatio = backfaceHits / rayCount;

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
        [color.r, color.g, color.b, color.a * t],
        backfaceRatio
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