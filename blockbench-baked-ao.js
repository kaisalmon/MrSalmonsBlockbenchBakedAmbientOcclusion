let button;

/* #fffa88bb */
const HIGHLIGHT_COLOR = {
    r: 231,
    g: 225,
    b: 164,
    a: 0.4
}

const SHADOW_COLOR = {
    r: 36,
    g: 11,
    b: 55,
    a: 0.5
}

const SAMPLES = 1000;

Plugin.register('blockbench-baked-ao', {
    title: 'Blockbench Baked AO',
    author: 'Kai Salmon',
    icon: 'icon',
    description: 'Baked Ambient Occlusion for Blockbench',
    version: '1.0.0',
    variant: 'both',
     onload() {
        button = new Action('bake_ambient_occlusion', {
            name: 'Bake Ambient Occlusion',
            description: 'Perform ambient occlusion baking on selected meshes',
            icon: 'cake',
            click: async function() {
                Undo.initEdit({elements: Mesh.selected});
                if(Mesh.selected.length === 0) {
                    Blockbench.showToastNotification({
                        text: 'No meshes selected',
                    })
                    return
                }
                
                let anyMissing = false;
                let anyWithTextures = false;
                let pixelCount = 0;
                
                // Show progress notification
                Blockbench.showToastNotification({
                    text: 'Starting ambient occlusion baking...',
                });
                
                performance.mark("startAO");

                for (const mesh of Mesh.selected) {
                    let hasSelectedFaces = false;
                    mesh.forAllFaces(face => {
                        if(face.isSelected()) {
                            hasSelectedFaces = true;
                        }
                    });
                    
                    // Process each face
                    await processMeshFaces(mesh, hasSelectedFaces, (missing, withTextures, processedPixels) => {
                        anyMissing = anyMissing || missing;
                        anyWithTextures = anyWithTextures || withTextures;
                        pixelCount += processedPixels;
                    });
                }
                performance.mark("endAO");
                const measure = performance.measure("AO Processing Time", "startAO", "endAO");
                console.log(`AO Processing Time: ${measure.duration}ms`);
                if(!anyWithTextures) {
                    Blockbench.showToastNotification({
                        text: 'No textures found on selected meshes',
                    });
                }else if(anyMissing) {
                    Blockbench.showToastNotification({
                        text: 'Some faces are missing textures',
                    });
                }else {
                    Blockbench.showToastNotification({
                        text: `Done! Processed ${pixelCount} pixels.`,
                    });
                }
                
                Undo.finishEdit('Bake Ambient Occlusion');
            }
        });
        MenuBar.addAction(button, 'filter');
    },
    onunload() {
        button.delete();
    }
});

/**
 * Process all faces of a mesh asynchronously
 * @param {Mesh} mesh - The mesh to process
 * @param {boolean} hasSelectedFaces - Whether the mesh has selected faces
 * @param {Function} callback - Callback to report progress
 */
async function processMeshFaces(mesh, hasSelectedFaces, callback) {
    let anyMissing = false;
    let anyWithTextures = false;
    let totalPixelsProcessed = 0;
    
    const faces = [];
    mesh.forAllFaces(face => faces.push(face));
    const cache = {}; 
    const [lowestY, highestY] = getHighestAndLowestY(mesh);
    const groundPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(1000, 1000),
        new THREE.MeshBasicMaterial({color: 0x000000, side: THREE.FrontSide, transparent: true, opacity: 0.5})
    );

    groundPlane.rotation.set(-Math.PI / 2, 0, 0); // Rotate to be horizontal
    groundPlane.position.setY(lowestY - 1);
    groundPlane.updateMatrix();
    groundPlane.updateWorldMatrix()

    for (const face of faces) {
        const tex = face.getTexture();
        if(!tex){
            anyMissing = true;
            continue;
        }
        
        if(hasSelectedFaces && !face.isSelected()) continue;
        
        anyWithTextures = true;
        const pixelsProcessed = await processFaceTexture(tex, face, mesh, cache, groundPlane);
        totalPixelsProcessed += pixelsProcessed;
    }
    
    callback(anyMissing, anyWithTextures, totalPixelsProcessed);
}

/**
 * Process a single face's texture asynchronously
 * @param {Texture} tex - The texture to edit
 * @param {MeshFace} face - The face being processed
 * @param {Mesh} mesh - The mesh containing the face
 * @returns {Promise<number>} - Number of pixels processed
 */
async function processFaceTexture(tex, face, mesh, cache, groundPlane) {
    return new Promise((resolve) => {
        tex.edit(async (htmlCanvasElement) => {
    
            await new Promise(resolve => setTimeout(resolve, 0));
            const ctx = htmlCanvasElement.getContext('2d');
            const occupationMatrix = face.getOccupationMatrix();
            
            let processedPixels = 0;
            
            // Collect all pixel coordinates first
            const pixelCoords = [];
            Object.keys(occupationMatrix).forEach(uStr => {
                Object.keys(occupationMatrix[uStr]).forEach(vStr => {
                    const value = occupationMatrix[uStr][vStr];
                    if(value === true) {
                        pixelCoords.push([parseInt(uStr, 10), parseInt(vStr, 10)]);
                    }
                });
            });
            
            // Process pixels in batches
            const getKey = (u, v) => `${u},${v}`;
            // Process this batch
            for (const [u, v] of pixelCoords) {
                const key = getKey(u, v);
                if (cache[key]) {
                    continue;
                }
                // Get x,y,z in 3d space of the face at this u,v
                const {x, y, z} = face.UVToLocal([u + 0.5, v + 0.5]);
                const [r, g, b, a] = calculateAmbientOcclusion([x, y, z], [u, v], face, mesh, groundPlane);
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
                ctx.fillRect(u, v, 1, 1);
                processedPixels++;
                cache[key] = true; // Mark this pixel as processed
            }
                
            resolve(processedPixels);
        });
    });
}
const vectorPool = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    normal: new THREE.Vector3()
};
/**
 * Calculates ambient occlusion at a specific point on a mesh face
 * @param {number[]} position - The [x,y,z] position in 3D space
 * @param {number[]} uv - The [u,v] texture coordinates
 * @param {MeshFace} face - The face being processed
 * @param {Mesh} mesh - The mesh containing the face
 * @returns {number[]} - RGB values [r,g,b] for the ambient occlusion
 */
function calculateAmbientOcclusion(position, uv, face, mesh, groundPlane) {
      const [x, y, z] = position;
    const [normalX, normalY, normalZ] = face.getNormal(true);
    
    // Reuse pooled vectors
    vectorPool.normal.set(normalX, normalY, normalZ);
    
    let occlusion = 0;
    const length = 8;
    const rayCount = SAMPLES;
    
    for(let i = 0; i < rayCount; i++) {
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

        const ray = new THREE.Raycaster(vectorPool.origin, vectorPool.direction, 0.001, length);
        const intersects = ray.intersectObjects([mesh.mesh, groundPlane]);
        
        if(intersects.length > 0) {
            occlusion += 1;
        }
    }
    // if (occlusion === 0) {
    //     return [255, 0, 0, 1]; // No occlusion detected, return white
    // }
    let occlusionFactor = 1 - occlusion / rayCount;

    // return [
    //     occlusionFactor*255,
    //     occlusionFactor*255,
    //     occlusionFactor*255,
    //     1
    // ]

    let t;
    let color;
    if(occlusionFactor < 0.5){
        t = (0.5 - occlusionFactor) * 2
        const shadowGamma = 1.0;
        t = Math.pow(t, shadowGamma);
        color = SHADOW_COLOR 
    }else{
        t = (occlusionFactor - 0.5) * 2;
        const highlightGamma = 0.5;
        t = Math.pow(t, highlightGamma);
        color = HIGHLIGHT_COLOR
    }
    return [
        color.r,
        color.g,
        color.b,
        color.a * t
    ]
}

function lerp(a,b,t){
    return a*(1-t) + b*t;
}

/**
 * Get the highest and lowest Y coordinates of all vertices in a mesh
 * @param {Mesh} mesh - The mesh to analyze
 * @returns {number[]} - [highestY, lowestY]
 */
function getHighestAndLowestY(mesh) {
    const {mesh: {geometry}} = mesh;
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
        console.log(geometry)
        throw new Error('Mesh does not have valid geometry attributes');
    }
   const positionAttribute = geometry.attributes.position;
    let highestY = -Infinity;
    let lowestY = Infinity;
    for (let i = 0; i < positionAttribute.count; i++) {
        const y = positionAttribute.getY(i);
        if (y > highestY) highestY = y;
        if (y < lowestY) lowestY = y;
    }
    return [lowestY, highestY];
}