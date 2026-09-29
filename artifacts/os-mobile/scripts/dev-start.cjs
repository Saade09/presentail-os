require("../../../scripts/src/metro-dev-start.cjs")({
  defaultPort: 22179,
  statusRegex: new RegExp("^GET \/status[\\s\\r\\n?]"),
});
