import Path from "./Path.js";

export default class Face{
    constructor(){
        // this.pointa = new Point()

        this.path = new Path(3, 3, 3);
        console.log(" in paths")
        this.path.appendPath(3, 3, -3);
        this.path.appendPath(-3, 3, 3);
        this.path.appendPath(-3, 3, -3);
        console.log(this.path)

    }
}
