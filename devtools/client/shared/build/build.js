/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */
/* globals process, __filename, __dirname */

/* Usage:  node build.js [LIST_OF_SOURCE_FILES...] OUTPUT_DIR
 *    Compiles all source files and places the results of the compilation in
 * OUTPUT_DIR.
 */

"use strict";

const isQuickJS = typeof require === 'undefined';
if (isQuickJS) {


    globalThis.__filename = scriptArgs[0];
    globalThis.__dirname = __filename.substring(0, __filename.lastIndexOf('/'));

    globalThis.process = {
        argv: ['quickjs', __filename, ...scriptArgs],
    };

    const moduleCache = {};
    // Custom fs and path implementations for QuickJS
    const builtinModules = {
        fs: {
            readFileSync: function(filePath) {
                const content = std.loadFile(filePath);
                if (content === null) {
                    throw new Error(`Failed to read file: ${filePath}`);
                }
                return content;
            },
            writeFileSync: function(filePath, data) {
                const fd = os.open(filePath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o666);
                const errorObj = {};
                const f = std.fdopen(fd, 'w', errorObj);
                if (!f) {
                    throw new Error(`Failed to open file for writing: ${errorObj.errno}`);
                }

                try {
                    // Use puts to write the string directly
                    f.puts(data);
                    f.close();
                } catch (e) {
                    os.close(fd);
                    throw new Error(`Failed to write to file: ${filePath}`);
                }

                // Close the file
                os.close(fd);
            },
            existsSync: function(filePath) {
                const [realPath, err] = os.realpath(filePath);
                return err === 0; // If err is 0, the path exists
            },
            mkdirSync: function(filePath) {
                const [realPath, err] = os.realpath(filePath);
                if (err === 0) {
                    const e = new Error("exists");
                    e["code"] = "EEXIST";
                    throw e;
                }
                const result = os.mkdir(filePath, 0o777);
                if (result < 0) {
                    throw new Error(`Failed to create directory: ${filePath}`);
                }
            },
        },
        path: {
            join: (...args) => args.join('/').replace(/\/+/g, '/'),
            dirname: (filePath) => filePath.substring(0, filePath.lastIndexOf('/')),
            basename: (filePath) => filePath.split('/').pop(),
            resolve: function(...segments) {
                let resolvedPath = '';

                for (let i = 0; i < segments.length; i++) {
                    const segment = segments[i];

                    if (segment === '') {
                        continue;
                    }

                    // If the segment is an absolute path, reset resolvedPath
                    if (segment.charAt(0) === '/') {
                        resolvedPath = segment;
                    } else {
                        // Join the segment to the resolvedPath
                        resolvedPath = this.join(resolvedPath, segment);
                    }
                }

                return resolvedPath || '/';
            }
        }
    };

    // Simple require function for QuickJS
    globalThis.require = function(path) {

        // Handle built-in modules (fs, path)
        if (builtinModules[path]) {
            return builtinModules[path];
        }

        // Resolve the full path (handle relative paths)
        if (!path.endsWith(".js")) {
            path += ".js";
        }
        const fullPath = path.startsWith('.')
            ? __dirname + '/' + path.substring(2)
            : path;



        // Return cached module if available
        if (moduleCache[fullPath]) {
            return moduleCache[fullPath];
        }

        // Read the file
        const code = std.loadFile(fullPath, "utf8");

        // Wrap the code to capture exports
        const wrappedCode = `
            (function() {
                const exports = {};
                const module = {exports};
                ${code}
                return module.exports;
            })()
        `;

        // Evaluate the wrapped code
        try {
            const moduleFn = std.evalScript(wrappedCode);

            // Cache and return the module
            moduleCache[fullPath] = moduleFn;
            return moduleFn;
        } catch(ex) {
            throw new Error("require failed with " + ex.message + " stack: " + ex.stack);
        }

    }
}

// eslint-disable-next-line mozilla/reject-relative-requires
const Babel = require("./babel");
const fs = require("fs");
const _path = require("path");

const defaultPlugins = ["proposal-class-properties"];

function transform(filePath) {
  // Use the extra plugins only for the debugger
  const plugins = filePath.includes("devtools/client/debugger")
    ? // eslint-disable-next-line mozilla/reject-relative-requires
      require("./build-debugger")(filePath)
    : defaultPlugins;

  const doc = fs.readFileSync(filePath, "utf8");

  let out;
  try {
    out = Babel.transform(doc, { plugins });
  } catch (err) {
    throw new Error(`
========================
NODE COMPILATION ERROR!

File:   ${filePath}
Stack:

${err.stack}

========================
`);
  }

  return out.code;
}

// fs.mkdirSync's "recursive" option appears not to work, so I'm writing a
// simple version of the function myself.
function mkdirs(filePath) {
  if (fs.existsSync(filePath)) {
    return;
  }
  mkdirs(_path.dirname(filePath));
  try {
    fs.mkdirSync(filePath);
  } catch (err) {
    // Ignore any errors resulting from the directory already existing.
    if (err.code != "EEXIST") {
      throw err;
    }
  }
}

const deps = [__filename, _path.resolve(__dirname, "babel.js")];
const outputDir = process.argv[process.argv.length - 1];
mkdirs(outputDir);

for (let i = 2; i < process.argv.length - 1; i++) {
  const srcPath = process.argv[i];
  const code = transform(srcPath);
  const fullPath = _path.join(outputDir, _path.basename(srcPath));
  fs.writeFileSync(fullPath, code);
  deps.push(srcPath);
}

// Print all dependencies prefixed with 'dep:' in order to help node.py, the script that
// calls this module, to report back the precise list of all dependencies.
console.log(deps.map(file => "dep:" + file).join("\n"));
