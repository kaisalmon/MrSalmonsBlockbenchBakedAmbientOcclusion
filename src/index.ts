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

// New interface for the face mapping
interface FaceMapping {
    faceIndexToBlockbenchFace: Map<number, MeshFace>;
}

let button: Action;

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
            click: function(): void {
                showAmbientOcclusionDialog();
            }
        });
        MenuBar.addAction(button, 'filter');
    },
    onunload(): void {
        button.delete();
    }
});

/**
 * Convert RGB color object to hex string for color picker
 */
function colorToHex(color: Color): string {
    const r = Math.round(color.r).toString(16).padStart(2, '0');
    const g = Math.round(color.g).toString(16).padStart(2, '0');
    const b = Math.round(color.b).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

/**
 * Convert hex string to RGB color object
 */
function hexToColor(hex: string, alpha: number): Color {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b, a: alpha };
}

/**
 * Show the ambient occlusion configuration dialog
 */
function showAmbientOcclusionDialog(): void {
    // Default values
    const defaultHighlightColor: Color = { r: 231, g: 225, b: 164, a: 0.4 };
    const defaultShadowColor: Color = { r: 36, g: 11, b: 55, a: 0.5 };
    
    const dialog = new Dialog('ambient_occlusion_config', {
        title: 'Ambient Occlusion Settings',
        width: 400,
        form: {
            highlight_color: {
                label: 'Highlight Color',
                type: 'color',
                value: colorToHex(defaultHighlightColor),
                description: 'Color used for areas with high ambient lighting'
            },
            highlight_alpha: {
                label: 'Highlight Opacity',
                type: 'range',
                min: 0,
                max: 1,
                step: 0.01,
                value: defaultHighlightColor.a,
                description: 'Opacity of the highlight color overlay'
            },
            highlight_gamma: {
                label: 'Highlight Gamma',
                type: 'range',
                min: 0.1,
                max: 3.0,
                step: 0.1,
                value: 0.5,
                description: 'Gamma correction for highlight areas (lower = more contrast)'
            },
            shadow_color: {
                label: 'Shadow Color',
                type: 'color',
                value: colorToHex(defaultShadowColor),
                description: 'Color used for occluded/shadowed areas'
            },
            shadow_alpha: {
                label: 'Shadow Opacity',
                type: 'range',
                min: 0,
                max: 1,
                step: 0.01,
                value: defaultShadowColor.a,
                description: 'Opacity of the shadow color overlay'
            },
            shadow_gamma: {
                label: 'Shadow Gamma',
                type: 'range',
                min: 0.1,
                max: 3.0,
                step: 0.1,
                value: 1.0,
                description: 'Gamma correction for shadow areas (higher = softer shadows)'
            },
            samples: {
                label: 'Ray Samples',
                type: 'number',
                min: 100,
                max: 5000,
                step: 100,
                value: 1000,
                description: 'Number of rays cast per pixel (higher = better quality, slower)'
            },
            retain_texture_transparency: {
                label: 'Retain Texture Transparency',
                type: 'checkbox',
                value: true,
                description: 'Preserve the original transparency of textures'
            },
            sample_texture_transparency: {
                label: 'Sample Texture Transparency',
                type: 'checkbox',
                value: false,
                description: 'Consider texture transparency when calculating occlusion (slower but more accurate)'
            }
        },
        onConfirm: function(formResult: any) {
            console.log({formResult})
            const options: BakeAmbientOcclusionOptions = {
                onProgress: (progress: number) => {
                    console.log(`Baking progress: ${(progress * 100).toFixed(2)}%`);
                },
                highlightColor: hexToColor(formResult.highlight_color.toHex(), formResult.highlight_alpha),
                shadowColor: hexToColor(formResult.shadow_color.toHex(), formResult.shadow_alpha),
                samples: formResult.samples,
                retainTextureTransparency: formResult.retain_texture_transparency,
                sampleTextureTransparency: formResult.sample_texture_transparency,
                shadowGamma: formResult.shadow_gamma,
                highlightGamma: formResult.highlight_gamma
            };
            
            bakeAmbientOcclusion(options);
        }
    });
    
    dialog.show();
}

interface BakeAmbientOcclusionOptions {
    onProgress?: (progress: number) => void;
    highlightColor: Color;
    shadowColor: Color;
    samples: number;
    retainTextureTransparency: boolean;
    sampleTextureTransparency: boolean;
    shadowGamma: number;
    highlightGamma: number;
}

async function bakeAmbientOcclusion(opts: BakeAmbientOcclusionOptions): Promise<void> {

    if (Mesh.selected.length === 0) {
        Blockbench.showToastNotification({
            text: 'No meshes selected',
        });
        return Promise.resolve();
    }

    let anyMissing: boolean = false;
    let anyWithTextures: boolean = false;
    let pixelCount: number = 0;
    let faceCount: number = 0;

    // Show progress notification
    Blockbench.showToastNotification({
        text: 'Starting ambient occlusion baking...',
    });

    performance.mark("startAO");

    for (const mesh of Mesh.selected) {
        let hasSelectedFaces: boolean = false;
        let facesInMesh = 0;
        mesh.forAllFaces((face: MeshFace) => {
            if (face.isSelected()) {
                hasSelectedFaces = true;
            }
            facesInMesh++;
        });
        
        // Process each face
        const result = await processMeshFaces(mesh, hasSelectedFaces, opts);
        anyMissing = anyMissing || result.anyMissing;
        anyWithTextures = anyWithTextures || result.anyWithTextures;
        pixelCount += result.totalPixelsProcessed;
        faceCount += result.totalFacesProcessed;
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

/**
 * Build a mapping from three.js face indices to Blockbench faces
 * This eliminates the need for expensive lookups during raycasting
 */
function buildFaceMapping(mesh: Mesh): FaceMapping {
    const faceIndexToBlockbenchFace = new Map<number, MeshFace>();
    let currentFaceIndex = 0;
    
    for (let key in mesh.faces) {
        const face = mesh.faces[key];
        const vertices = face.vertices;
        
        if (vertices.length < 3) continue;
        
        if (vertices.length === 3) {
            // Triangle face uses 1 three.js face
            faceIndexToBlockbenchFace.set(currentFaceIndex, face);
            currentFaceIndex += 1;
        } else if (vertices.length === 4) {
            // Quad face uses 2 three.js faces (triangulated)
            faceIndexToBlockbenchFace.set(currentFaceIndex, face);
            faceIndexToBlockbenchFace.set(currentFaceIndex + 1, face);
            currentFaceIndex += 2;
        }
    }
    
    return { faceIndexToBlockbenchFace };
}

interface ProcessMeshFacesResult {
    anyMissing: boolean;
    anyWithTextures: boolean;
    totalPixelsProcessed: number;
    totalFacesProcessed: number;
}

/**
 * Process all faces of a mesh asynchronously
 * @param mesh - The mesh to process
 * @param hasSelectedFaces - Whether the mesh has selected faces
 */
async function processMeshFaces(mesh: Mesh, hasSelectedFaces: boolean, opts: BakeAmbientOcclusionOptions): Promise<ProcessMeshFacesResult> {
    let anyMissing: boolean = false;
    let anyWithTextures: boolean = false;
    let totalPixelsProcessed: number = 0;
    let totalFacesProcessed = 0;
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
    
    const [lowestY]: [number, number] = getHighestAndLowestY(mesh);
    
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
    const geometryBackup = geometry.clone(); // Backup as BVH mutates the geometry in a way that causes bugs in Blockbench
    const bvh: MeshBVH = new MeshBVH(geometry, {
        indirect: true,
        maxDepth: 1000,
        maxLeafTris: 1,
    });
    
    // Build face mapping once per mesh - this is the key optimization!
    const faceMapping = buildFaceMapping(mesh);
    
    try {
        // Process each texture
        for (const [texture, textureFaces] of facesByTexture) {
            const { pixelsProcessed, facesProcessed } = await processTextureWithFaces(texture, textureFaces, mesh, groundPlane, bvh, faceMapping, opts);
            totalPixelsProcessed += pixelsProcessed;
            totalFacesProcessed += facesProcessed;
        }

        return { anyMissing, anyWithTextures, totalPixelsProcessed, totalFacesProcessed };
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
 * @param faceMapping - Pre-computed mapping from face indices to Blockbench faces
 * @returns Number of pixels processed
 */
async function processTextureWithFaces(
    texture: Texture, 
    faces: MeshFace[], 
    mesh: Mesh, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH,
    faceMapping: FaceMapping,
    opts: BakeAmbientOcclusionOptions
): Promise<{
    pixelsProcessed: number;
    facesProcessed: number;
}> {
    
    // Track best result for each pixel
    const bestResults: Map<string, PixelResult> = new Map();
    
    let facesProcessed: number = 0;
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
            const result = calculateAmbientOcclusion([x, y, z], [u, v], face, mesh, groundPlane, bvh, faceMapping, opts);

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
        facesProcessed++;
        opts?.onProgress?.(facesProcessed / faces.length);
    }
    
    // Apply all results in a single edit session
    let processedPixels: number = 0;
    texture.edit((htmlCanvasElement: HTMLCanvasElement) => {
        const ctx: CanvasRenderingContext2D = htmlCanvasElement.getContext('2d')!;
        
        for (const [pixelKey, result] of bestResults) {
            const [u, v] = pixelKey.split(',').map(x => parseInt(x, 10));
            let [r, g, b, a] = result.color;

            if (opts.retainTextureTransparency) {
                const srcAlpha = ctx.getImageData(u, v, 1, 1).data[3];
                a *= srcAlpha / 255;
            }

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(u, v, 1, 1);
            processedPixels++;
        }
    });

    return {
        pixelsProcessed: processedPixels,
        facesProcessed: faces.length
    };
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
 * @param faceMapping - Pre-computed mapping from face indices to Blockbench faces
 * @returns [RGBA values, backface ratio] for the ambient occlusion, or null if backface ratio > 25%
 */
function calculateAmbientOcclusion(
    position: [number, number, number], 
    uv: [number, number], 
    face: MeshFace, 
    mesh: Mesh, 
    groundPlane: THREE.Mesh,
    bvh: MeshBVH,
    faceMapping: FaceMapping,
    opts: BakeAmbientOcclusionOptions
): [[number, number, number, number], number] | null {
    const [x, y, z]: [number, number, number] = position;
    const [normalX, normalY, normalZ]: [number, number, number] = face.getNormal(true);
    
    // Reuse pooled vectors
    vectorPool.normal.set(normalX, normalY, normalZ);
    
    let occlusion: number = 0;
    let backfaceHits: number = 0;
    const length: number = 8;
    const rayCount: number = opts.samples;

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
            if(!opts.sampleTextureTransparency){
                occlusion += 1;
            }else{
                // Use the optimized face lookup instead of the expensive linear search
                const blockbenchFace = faceMapping.faceIndexToBlockbenchFace.get(hit.faceIndex!);
                if (blockbenchFace) {
                    const [hitU, hitV] = blockbenchFace.localToUV(hit.point!);
                    const texture: Texture | undefined = blockbenchFace.getTexture();
                    if (texture) {
                        const pixelColor: ImageData = texture.ctx.getImageData(hitU, hitV, 1, 1);
                        occlusion += pixelColor.data[3] / 255;
                    } else {
                        occlusion += 1;
                    }
                } else {
                    // Fallback to 1 if face not found (shouldn't happen with proper mapping)
                    occlusion += 1;
                }
            }
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
        t = Math.pow(t, opts.shadowGamma);
        color = opts.shadowColor;
    } else {
        t = (occlusionFactor - 0.5) * 2;
        t = Math.pow(t, opts.highlightGamma);
        color = opts.highlightColor;
    }

    return [
        [color.r, color.g, color.b, color.a * t],
        backfaceRatio
    ];
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