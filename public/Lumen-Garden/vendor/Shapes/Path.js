import Point from "../Point.js";

export default class Path {
    constructor(x, y, z) {

        this.x = x;
        this.y = y;
        this.z = z;

        this.point = new Point(x, y, z);

        this.head =this;
        this.tail ;

        this.nextPath = undefined;
    }

    appendPath(x, y, z) {
        // console.log(x+","+y+","+z);

        let sudoPath = this.head;
        // console.log(sudoPath)

        // console.log("---------------------------")
        while (sudoPath.nextPath!= undefined) {
            // console.log(sudoPath)
            sudoPath = sudoPath.nextPath
        }
        // console.log("---------------------------")

        sudoPath.nextPath = new Path(x, y, z);
        // console.log(new Path(x, y, z));
        // this.nextPath = sudoPath;
        this.tail = sudoPath.nextPath;
    }



}
