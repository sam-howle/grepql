const { buildSchema, introspectionFromSchema } = require("graphql");
const fs = require("fs");
const sdl = fs.readFileSync("../examples/sample-schema.graphql", "utf8");
const schema = buildSchema(sdl);
const introspection = introspectionFromSchema(schema);
fs.writeFileSync("../examples/sample-introspection.json", JSON.stringify({ data: introspection }, null, 2));
console.log("wrote sample-introspection.json");
