function normalize(path) {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

exports.resolve = (...segments) => normalize(segments.filter(Boolean).join("/"));
exports.join = exports.resolve;
