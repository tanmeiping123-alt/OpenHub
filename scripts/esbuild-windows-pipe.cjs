// esbuild 0.19 passes >1MB transforms through temp files. On this Windows
// installation the Go process cannot remove a file created by Node, even after
// Node closes it. Returning a write error uses esbuild's built-in pipe fallback.
// This preload is restricted to the whiteboard build process and temp filenames.
const fs = require("node:fs");
const originalWriteFile = fs.writeFile;
fs.writeFile = function (file, ...args) {
  if (typeof file === "string" && /[\\/]esbuild-[a-f0-9]+$/.test(file)) {
    const callback = args.at(-1);
    const error = Object.assign(
      new Error("Use esbuild pipe transport on Windows"),
      { code: "EACCES" },
    );
    process.nextTick(callback, error);
    return;
  }
  return originalWriteFile.call(this, file, ...args);
};
