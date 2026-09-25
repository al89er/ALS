// Module Loader - Dynamic module resolver with fail-safe factory fallback
// Provides hot-updatable architecture for ALS Single Agent and Hub editions.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

let activeModulesDir = null;
let activeBaseDir = __dirname;
const loadedModulesInfo = {};
const moduleCache = new Map();

/**
 * Resolves the default modules directory based on runtime environment.
 */
function getDefaultModulesDir() {
  if (process.env.ALS_MODULES_DIR) {
    return process.env.ALS_MODULES_DIR;
  }
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'modules');
    }
  } catch (e) {}
  return path.join(__dirname, 'modules');
}

/**
 * Initializes the module loader configuration.
 * @param {Object} [options]
 * @param {string} [options.modulesDir]
 * @param {string} [options.baseDir]
 */
function init(options = {}) {
  activeBaseDir = options.baseDir || __dirname;
  activeModulesDir = options.modulesDir || getDefaultModulesDir();
  ensureModulesDir();
  return {
    modulesDir: activeModulesDir,
    baseDir: activeBaseDir
  };
}

/**
 * Gets the current active modules directory.
 */
function getModulesDir() {
  if (!activeModulesDir) {
    activeModulesDir = getDefaultModulesDir();
  }
  return activeModulesDir;
}

/**
 * Ensures the modules directory exists.
 */
function ensureModulesDir() {
  const dir = getModulesDir();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn('[MODULE-LOADER] Could not create modules directory:', err.message);
    }
  }
  return dir;
}

/**
 * Resolves the path to an HTML UI file, checking dynamic updates first.
 * @param {string} fileName - E.g. 'hub-ui.html' or 'desktop-ui.html'
 * @param {string} fallbackPath - Default path bundled with app
 * @returns {string} Path to load in BrowserWindow
 */
function resolveUIPath(fileName, fallbackPath) {
  try {
    const dynamicFile = path.join(getModulesDir(), fileName);
    if (fs.existsSync(dynamicFile)) {
      const stats = fs.statSync(dynamicFile);
      if (stats.isFile() && stats.size > 100) {
        loadedModulesInfo[fileName] = {
          source: 'dynamic',
          path: dynamicFile,
          size: stats.size,
          mtime: stats.mtime
        };
        return dynamicFile;
      }
    }
  } catch (err) {
    console.warn(`[MODULE-LOADER] Error resolving dynamic UI for ${fileName}:`, err.message);
  }

  loadedModulesInfo[fileName] = {
    source: 'factory',
    path: fallbackPath
  };
  return fallbackPath;
}

/**
 * Evaluates and requires a dynamic module file in a sandboxed module wrapper.
 * @param {string} filePath - Absolute path to .js file in modules dir
 * @param {string} baseDir - Base directory containing node_modules
 * @returns {Object} Exported module contents
 */
function compileAndRequireDynamicModule(filePath, baseDir) {
  const code = fs.readFileSync(filePath, 'utf8');

  // Syntax validation pass
  const script = new vm.Script(Module.wrap(code), {
    filename: filePath,
    displayErrors: true
  });

  const customRequire = function(id) {
    // 1. Sibling relative require
    if (id.startsWith('./') || id.startsWith('../')) {
      const baseName = path.basename(id, '.js');
      const dynamicSibling = path.join(path.dirname(filePath), baseName + '.js');
      if (fs.existsSync(dynamicSibling)) {
        return compileAndRequireDynamicModule(dynamicSibling, baseDir);
      }
      const factoryPath = path.resolve(baseDir, id);
      return require(factoryPath);
    }

    // 2. Known internal modules without relative syntax
    const knownModules = [
      'automation',
      'scheduler',
      'hub-client',
      'cache-manager',
      'supabase-client',
      'supabase-config',
      'tray-manager',
      'module-loader',
      'module-updater'
    ];
    if (knownModules.includes(id)) {
      const dynamicSibling = path.join(path.dirname(filePath), id + '.js');
      if (fs.existsSync(dynamicSibling)) {
        return compileAndRequireDynamicModule(dynamicSibling, baseDir);
      }
      return require(path.join(baseDir, id));
    }

    // 3. Bundled dependencies (playwright, dotenv, etc.)
    try {
      const baseRequire = Module.createRequire(path.join(baseDir, 'package.json'));
      return baseRequire(id);
    } catch (e) {
      return require(id);
    }
  };

  const moduleObj = {
    exports: {},
    id: filePath,
    filename: filePath,
    loaded: false,
    paths: Module._nodeModulePaths(path.dirname(filePath))
  };

  const compiledWrapper = script.runInThisContext();
  compiledWrapper(
    moduleObj.exports,
    customRequire,
    moduleObj,
    filePath,
    path.dirname(filePath)
  );
  moduleObj.loaded = true;

  return moduleObj.exports;
}

/**
 * Loads a module dynamically from the user modules directory if present.
 * Seamlessly falls back to factory-bundled export if file does not exist,
 * has syntax errors, or throws an error during evaluation.
 *
 * @param {string} name - Module name without extension (e.g. 'automation', 'hub-client')
 * @param {Object} fallbackExport - Bundled module instance (e.g. require('./automation'))
 * @returns {Object} The resolved module
 */
function loadModule(name, fallbackExport) {
  if (moduleCache.has(name)) {
    return moduleCache.get(name);
  }

  const dynamicPath = path.join(getModulesDir(), `${name}.js`);

  if (fs.existsSync(dynamicPath)) {
    try {
      const dynamicExport = compileAndRequireDynamicModule(dynamicPath, activeBaseDir);
      
      // Determine version if exported
      const version = dynamicExport.VERSION || dynamicExport.version || 'custom';

      loadedModulesInfo[name] = {
        source: 'dynamic',
        path: dynamicPath,
        version: version
      };

      console.log(`[MODULE-LOADER] Successfully loaded dynamic module: ${name} (v${version})`);
      moduleCache.set(name, dynamicExport);
      return dynamicExport;
    } catch (err) {
      console.error(`[MODULE-LOADER] Dynamic module "${name}" failed to initialize (${err.message}). Safe rollback triggered.`);
      
      // Quarantine / remove corrupted file to prevent recurrent startup failure
      try {
        const quarantinePath = `${dynamicPath}.corrupt-${Date.now()}`;
        fs.renameSync(dynamicPath, quarantinePath);
        console.warn(`[MODULE-LOADER] Quarantined corrupted module to: ${quarantinePath}`);
      } catch (quarantineErr) {
        try { fs.unlinkSync(dynamicPath); } catch (_) {}
      }
    }
  }

  // Fallback to factory-bundled module
  const factoryVersion = fallbackExport && (fallbackExport.VERSION || fallbackExport.version) 
    ? (fallbackExport.VERSION || fallbackExport.version) 
    : 'factory';

  loadedModulesInfo[name] = {
    source: 'factory',
    path: path.join(activeBaseDir, `${name}.js`),
    version: factoryVersion
  };

  moduleCache.set(name, fallbackExport);
  return fallbackExport;
}

function extractVersionFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '1.5.8';
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/(?:VERSION\s*=\s*['"]|<!--\s*VERSION:\s*)([^'"\s>]+)/);
    if (match) return match[1];
  } catch (e) {}
  return '1.5.8';
}

/**
 * Returns metadata of currently loaded modules and on-disk modular targets.
 */
function getLoadedModuleInfo() {
  const info = { ...loadedModulesInfo };

  const knownTargets = [
    { name: 'automation', file: 'automation.js' },
    { name: 'hub-client', file: 'hub-client.js' },
    { name: 'scheduler', file: 'scheduler.js' },
    { name: 'supabase-client', file: 'supabase-client.js' },
    { name: 'cache-manager', file: 'cache-manager.js' },
    { name: 'tray-manager', file: 'tray-manager.js' },
    { name: 'hub-ui', file: 'hub-ui.html' },
    { name: 'desktop-ui', file: 'desktop-ui.html' }
  ];

  for (const t of knownTargets) {
    if (!info[t.name]) {
      const dynamicPath = path.join(activeModulesDir, t.file);
      const factoryPath = path.join(activeBaseDir, t.file);

      if (fs.existsSync(dynamicPath)) {
        info[t.name] = {
          source: 'dynamic',
          path: dynamicPath,
          version: extractVersionFromFile(dynamicPath)
        };
      } else if (fs.existsSync(factoryPath)) {
        info[t.name] = {
          source: 'factory',
          path: factoryPath,
          version: extractVersionFromFile(factoryPath)
        };
      }
    }
  }

  return info;
}

/**
 * Clears cached module reference (useful during test or after installing update).
 * @param {string} [name] - Specific module name, or clears all if omitted
 */
function clearModuleCache(name) {
  if (name) {
    moduleCache.delete(name);
    delete loadedModulesInfo[name];
  } else {
    moduleCache.clear();
    Object.keys(loadedModulesInfo).forEach(k => delete loadedModulesInfo[k]);
  }
}

module.exports = {
  init,
  getModulesDir,
  ensureModulesDir,
  resolveUIPath,
  loadModule,
  getLoadedModuleInfo,
  clearModuleCache,
  __test: {
    compileAndRequireDynamicModule,
    getDefaultModulesDir
  }
};
