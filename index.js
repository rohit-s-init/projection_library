const express = require("express");
require("dotenv").config();
const { registerMinecraftAI } = require("./server/minecraftAI");
const app = express();


app.use(express.static("public"));
app.use(express.json({ limit: "64kb" }));

// AI companion for public/minecraft (uses groq_api from .env)
registerMinecraftAI(app);



const port = process.env.PORT || 9601;
app.listen(port, () => {
    console.log(`listening on http://localhost:${port}/`)
})
