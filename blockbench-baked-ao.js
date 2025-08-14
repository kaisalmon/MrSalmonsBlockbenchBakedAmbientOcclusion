let button;

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
            click: function() {
                Undo.initEdit({elements: Mesh.selected});
                if(Mesh.selected.length === 0) {
                    Blockbench.showToastNotification({
                        text: 'No meshes selected',
                    })
                    return
                }
                let anyMissing = false;
                let anyWithTextures = false;
                Mesh.selected.forEach(mesh => {
                    let hasSelectedFaces = false;
                    mesh.forAllFaces(face => {
                        if(face.isSelected()) {
                            hasSelectedFaces = true;
                        }
                    });
                    mesh.forAllFaces(face => {
                        const tex = face.getTexture();
                        if(!tex){
                            anyMissing = true;
                            return;
                        }
                        console.log(tex)
                        if(hasSelectedFaces && !face.isSelected()) return
                        anyWithTextures = true;
                        tex.edit(htmlCanvasElement => {
                            const ctx = htmlCanvasElement.getContext('2d');
                            const occupationMatrix = face.getOccupationMatrix();
                            Object.keys(occupationMatrix).forEach(uStr => {
                                Object.keys(occupationMatrix[uStr]).forEach(vStr => {
                                    const value = occupationMatrix[uStr][vStr];
                                    if(value !== true) return;
                                    const u = parseInt(uStr, 10);
                                    const v = parseInt(vStr, 10);
                                    // Get x,y,z in 3d space of the face at this u,v
                                    const {x, y, z} = face.UVToLocal([u + 0.5, v + 0.5]);
                                    mesh
                                    const [r,g,b] = calculateAmbientOcclusion([x,y,z], [u,v], face, mesh)
                                    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 1)`;
                                    ctx.fillRect(u, v, 1, 1);
                                });
                            });
                        });
                       
                    });
                });
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
                        text: 'Done!',
                    });
                }
                // Canvas.updateView({
                //     elements: Cube.selected,
                //     element_aspects: {geometry: true},
                //     selection: true
                // });
                Undo.finishEdit('Randomize cube height');
            }
        });
        MenuBar.addAction(button, 'filter');
    },
    onunload() {
        button.delete();
    }
});

/**
 * Calculates ambient occlusion at a specific point on a mesh face
 * @param {number[]} position - The [x,y,z] position in 3D space
 * @param {number[]} uv - The [u,v] texture coordinates
 * @param {MeshFace} face - The face being processed
 * @param {Mesh} mesh - The mesh containing the face
 * @returns {number[]} - RGB values [r,g,b] for the ambient occlusion
 */
function calculateAmbientOcclusion(position, uv, face, mesh) {
    const [x, y, z] = position;
    const [u, v] = uv;
    // return [x*10 - 20, y*10 - 20, z*10 - 20]; // Placeholder for actual AO calculation
    const [normalX, normalY, normalZ] = face.getNormal();
    const normal = new THREE.Vector3(normalX, normalY, normalZ);
    // return [(normalX + 1) * 127.5, (normalY + 1) * 127.5, (normalZ + 1) * 127.5]; // Placeholder for actual AO calculation
    let occlusion = 0;
    const length = 16;
    const rayCount = 1000; // Number of rays to cast for occlusion
    for(let i = 0; i < rayCount; i++) {
        const origin = new THREE.Vector3(x, y, z)
        /*
            .add(normal.multiplyScalar(.1)); // Offset slightly to avoid self-intersection
        origin.x += (Math.random() - 0.5) * 0.05; // Randomize origin slightly
        origin.y += (Math.random() - 0.5) * 0.05;
        origin.z += (Math.random() - 0.5) * 0.05;
        */
        const direction =  new THREE.Vector3(
            (Math.random() - 0.5) * 2, // Random direction in x
            (Math.random() - 0.5) * 2, // Random direction in y
            (Math.random() - 0.5) * 2  // Random direction in z
        ).normalize(); 
        const ray = new THREE.Raycaster(origin, direction, 0.001, length);
        const intersects = ray.intersectObjects([mesh.mesh]);
        if(intersects.length === 0) {
            continue; // No intersection, continue to next random direction
        }
        occlusion += 1; // Increment occlusion count
    }
    let occlusionFactor = 1 - occlusion / rayCount;
    return [255 * occlusionFactor, 255 * occlusionFactor, 255 * occlusionFactor]; // Return grayscale color based on occlusion
}
