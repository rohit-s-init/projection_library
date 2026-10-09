// Space from the projection3d library, set up for Gearworks:
//  - the library's buffers hold the static scene (cabinet, playfield, rails, posts, backboard), built once
//  - a second buffer pair holds everything that moves, rebuilt every frame
//  - camera maths (updateMyVectors, the axis vectors) and the uniform locations are Space's own
//
// Space's own reDraw() re-uploads posArr and is also triggered by its Z/Q/P key handler; here it is a no-op so
// those keys can't overwrite the static scene.

import Space from "../Space.js";

export default class GameSpace extends Space {
    constructor(gl) {
        super(gl);
        this.dynPosBuffer = gl.createBuffer();
        this.dynColBuffer = gl.createBuffer();
        this.staticCount = 0;
        this.dynamicCount = 0;
    }

    reDraw() { }

    // camera at (x, y, z) looking at the point (tx, ty, tz)
    lookAt(x, y, z, tx, ty, tz) {
        this.Xc = x; this.Yc = y; this.Zc = z;
        this.X0 = tx; this.Y0 = ty; this.Z0 = tz;
        this.updateMyVectors();
    }

    setStatic(pos, col, count) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, count * 4), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, count * 4), gl.STATIC_DRAW);
        this.staticCount = count;
    }

    setDynamic(pos, col, count) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dynPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, pos.subarray(0, count * 4), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.dynColBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, col.subarray(0, count * 4), gl.DYNAMIC_DRAW);
        this.dynamicCount = count;
    }

    // Space's camera → the current program's uniforms (locations were pointed at our program)
    applyCamera() {
        const gl = this.gl;
        gl.uniform3f(this.cPointLoc, this.Xc, this.Yc, this.Zc);
        gl.uniform3fv(this.xAxisLoc, this.xUnitVec);
        gl.uniform3fv(this.yAxisLoc, this.yUnitVec);
        gl.uniform3fv(this.zAxisLoc, this.zUnitVec);
    }

    bind(dynamic) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, dynamic ? this.dynPosBuffer : this.posBuffer);
        gl.vertexAttribPointer(this.posId, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, dynamic ? this.dynColBuffer : this.colBuffer);
        gl.vertexAttribPointer(this.colId, 4, gl.FLOAT, false, 0, 0);
    }

    draw(first, count) {
        if (count > 0) this.gl.drawArrays(this.gl.TRIANGLES, first, count);
    }
}
