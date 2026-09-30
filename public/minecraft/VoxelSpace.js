// Space from the library, with two additions for a voxel world:
//  - the vertex buffers are only re-uploaded when the mesh actually changed (Space.reDraw uploads posArr/colArr
//    every frame, which is too slow for a large world)
//  - drawRange() draws part of the buffers, so opaque blocks, see-through blocks and the shadow pass can be
//    drawn separately from the same data
// Camera maths, buffers, attribute setup and uniforms are all still Space's.
//
// Note: Space's xUnitVec points to the LEFT of the screen (looking along +x with z up it is +y). The block
// shaders negate it, otherwise the picture is mirrored and turning the mouse feels inverted.

import Space from "../Space.js";

export default class VoxelSpace extends Space {
    constructor(gl) {
        super(gl);
        this.meshDirty = true;
    }

    // call after replacing posArr / colArr / totalVert
    setMesh(posArr, colArr, totalVert) {
        this.posArr = posArr;
        this.colArr = colArr;
        this.totalVert = totalVert;
        this.meshDirty = true;
    }

    // look from (x, y, z) towards direction (dx, dy, dz): Space's camera point + a view point one unit ahead
    lookFrom(x, y, z, dx, dy, dz) {
        this.Xc = x; this.Yc = y; this.Zc = z;
        this.X0 = x + dx; this.Y0 = y + dy; this.Z0 = z + dz;
    }

    drawRange(first, count) {
        const gl = this.gl;
        this.updateMyVectors();

        if (this.meshDirty) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.posArr, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.colArr, gl.STATIC_DRAW);
            this.meshDirty = false;
        }

        gl.uniform3fv(this.cPointLoc, new Float32Array([this.Xc, this.Yc, this.Zc]));
        gl.uniform3fv(this.vPointLoc, new Float32Array([this.X0, this.Y0, this.Z0]));
        gl.uniform3fv(this.xAxisLoc, new Float32Array(this.xUnitVec));
        gl.uniform3fv(this.yAxisLoc, new Float32Array(this.yUnitVec));
        gl.uniform3fv(this.zAxisLoc, new Float32Array(this.zUnitVec));

        if (count > 0) gl.drawArrays(gl.TRIANGLES, first, count);
    }

    reDraw() {
        this.drawRange(0, this.totalVert);
    }
}
