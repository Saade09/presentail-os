require("../../../scripts/src/metro-dev-start.cjs")({
  defaultPort: 22177,
  statusRegex: new RegExp("^GET .*\\/status[\\s\\r\\n?]"),
});
