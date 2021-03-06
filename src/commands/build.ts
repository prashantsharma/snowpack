import chalk from 'chalk';
import {EventEmitter} from 'events';
import execa from 'execa';
import npmRunPath from 'npm-run-path';
import path from 'path';
import {promises as fs, createReadStream, existsSync} from 'fs';
import os from 'os';
import glob from 'glob';
import {SnowpackConfig, DevScript} from '../config';
import {paint} from './paint';
import rimraf from 'rimraf';
import yargs from 'yargs-parser';
import srcFileExtensionMapping from './src-file-extension-mapping';
import {transformEsmImports} from '../rewrite-imports';
import mkdirp from 'mkdirp';
import {ImportMap} from '../util';
const {copy} = require('fs-extra');

interface DevOptions {
  cwd: string;
  config: SnowpackConfig;
}

export async function command({cwd, config}: DevOptions) {
  process.env.NODE_ENV = 'production';

  const messageBus = new EventEmitter();
  const allRegisteredWorkers = Object.entries(config.scripts);
  const relevantWorkers: [string, DevScript][] = [];
  const allWorkerPromises: Promise<any>[] = [];

  const isBundled = config.devOptions.bundle;
  const finalDirectoryLoc = config.devOptions.out;
  const buildDirectoryLoc = isBundled ? path.join(cwd, `.build`) : config.devOptions.out;
  const distDirectoryLoc = path.join(buildDirectoryLoc, config.devOptions.dist);
  const dependencyImportMapLoc = path.join(config.installOptions.dest, 'import-map.json');
  const dependencyImportMap: ImportMap = require(dependencyImportMapLoc);

  if (allRegisteredWorkers.filter(([id]) => id.startsWith('build')).length === 0) {
    console.error(chalk.red(`No build scripts found, so nothing to build.`));
    console.error(`See https://www.snowpack.dev/#build-scripts for help configuring your build.`);
    return;
  }

  rimraf.sync(finalDirectoryLoc);
  mkdirp.sync(finalDirectoryLoc);
  if (finalDirectoryLoc !== buildDirectoryLoc) {
    rimraf.sync(buildDirectoryLoc);
    mkdirp.sync(buildDirectoryLoc);
  }

  const extToWorkerMap: {[ext: string]: any[]} = {};
  for (const [id, workerConfig] of allRegisteredWorkers) {
    if (
      id.startsWith('build:') ||
      id.startsWith('plugin:') ||
      id.startsWith('lintall:') ||
      id.startsWith('mount:')
    ) {
      relevantWorkers.push([id, workerConfig]);
    }
    if (id.startsWith('build:') || id.startsWith('plugin:')) {
      const exts = id.split(':')[1].split(',');
      for (const ext of exts) {
        extToWorkerMap[ext] = extToWorkerMap[ext] || [];
        extToWorkerMap[ext].push([id, workerConfig]);
      }
    }
  }

  if (isBundled) {
    relevantWorkers.push(['bundle:*', {cmd: 'NA', watch: undefined}]);
  }

  console.log = (...args) => {
    messageBus.emit('CONSOLE', {level: 'log', args});
  };
  console.warn = (...args) => {
    messageBus.emit('CONSOLE', {level: 'warn', args});
  };
  console.error = (...args) => {
    messageBus.emit('CONSOLE', {level: 'error', args});
  };
  let relDest = path.relative(cwd, config.devOptions.out);
  if (!relDest.startsWith(`..${path.sep}`)) {
    relDest = `.${path.sep}` + relDest;
  }
  paint(messageBus, relevantWorkers, {dest: relDest}, undefined);

  for (const [id, workerConfig] of relevantWorkers) {
    if (!id.startsWith('lintall:')) {
      continue;
    }
    messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
    const workerPromise = execa.command(workerConfig.cmd, {
      env: npmRunPath.env(),
      extendEnv: true,
      shell: true,
    });
    allWorkerPromises.push(workerPromise);
    workerPromise.catch((err) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
    });
    workerPromise.then(() => {
      messageBus.emit('WORKER_COMPLETE', {id, error: null});
    });
    const {stdout, stderr} = workerPromise;
    stdout?.on('data', (b) => {
      let stdOutput = b.toString();
      if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
        messageBus.emit('WORKER_RESET', {id});
        stdOutput = stdOutput.replace(/\x1Bc/, '').replace(/\u001bc/, '');
      }
      if (id.endsWith(':tsc')) {
        if (stdOutput.includes('\u001bc') || stdOutput.includes('\x1Bc')) {
          messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
        }
        if (/Watching for file changes./gm.test(stdOutput)) {
          messageBus.emit('WORKER_UPDATE', {id, state: 'WATCHING'});
        }
        const errorMatch = stdOutput.match(/Found (\d+) error/);
        if (errorMatch && errorMatch[1] !== '0') {
          messageBus.emit('WORKER_UPDATE', {id, state: ['ERROR', 'red']});
        }
      }
      messageBus.emit('WORKER_MSG', {id, level: 'log', msg: stdOutput});
    });
    stderr?.on('data', (b) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: b.toString()});
    });
  }

  for (const [id, workerConfig] of relevantWorkers) {
    if (!id.startsWith('mount:')) {
      continue;
    }
    const cmdArr = workerConfig.cmd.split(/\s+/);
    if (cmdArr[0] !== 'mount') {
      throw new Error(`script[${id}] must use the mount command`);
    }
    cmdArr.shift();
    let dirUrl, dirDisk;
    if (cmdArr.length === 1) {
      dirDisk = path.resolve(cwd, cmdArr[0]);
      dirUrl = '/' + cmdArr[0];
    } else {
      const {to} = yargs(cmdArr);
      dirDisk = path.resolve(cwd, cmdArr[0]);
      dirUrl = to;
    }

    const destinationFile =
      dirUrl === '/' ? buildDirectoryLoc : path.join(buildDirectoryLoc, dirUrl);
    await copy(dirDisk, destinationFile).catch((err) => {
      messageBus.emit('WORKER_MSG', {id, level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id, error: err});
      throw err;
    });
    messageBus.emit('WORKER_COMPLETE', {id, error: null});
  }

  if (config.include) {
    const allFiles = glob.sync(`${config.include}/**/*`, {
      nodir: true,
      ignore: [`${config.include}/**/__tests__`, `${config.include}/**/*.{spec,test}.*`],
    });

    for (const [id, workerConfig] of relevantWorkers) {
      if (!id.startsWith('build:') && !id.startsWith('plugin:')) {
        continue;
      }
      messageBus.emit('WORKER_UPDATE', {id, state: ['RUNNING', 'yellow']});
      for (const f of allFiles) {
        const fileExtension = path.extname(f).substr(1);
        if (!id.includes(`:${fileExtension}`) && !id.includes(`,${fileExtension}`)) {
          continue;
        }

        let {cmd} = workerConfig;
        if (id.startsWith('build:')) {
          const {stdout, stderr} = await execa.command(cmd, {
            env: npmRunPath.env(),
            extendEnv: true,
            shell: true,
            input: createReadStream(f),
          });
          if (stderr) {
            console.error(stderr);
          }
          if (!stdout) {
            continue;
          }
          let outPath = f.replace(config.include, distDirectoryLoc);
          const extToFind = path.extname(f).substr(1);
          const extToReplace = srcFileExtensionMapping[extToFind];
          if (extToReplace) {
            outPath = outPath.replace(new RegExp(`${extToFind}$`), extToReplace!);
          }
          let code = stdout;
          if (path.extname(outPath) === '.js') {
            code = await transformEsmImports(code, (spec) => {
              if (spec.startsWith('http') || spec.startsWith('/')) {
                return spec;
              }
              if (spec.startsWith('./') || spec.startsWith('../')) {
                const ext = path.extname(spec).substr(1);
                if (!ext) {
                  console.error(`${f}: Import ${spec} is missing a required file extension.`);
                  return spec;
                }
                const extToReplace = srcFileExtensionMapping[ext];
                if (extToReplace) {
                  return spec.replace(new RegExp(`${ext}$`), extToReplace);
                }
                return spec;
              }
              if (dependencyImportMap.imports[spec]) {
                return `/web_modules/${dependencyImportMap.imports[spec]}`;
              }
              messageBus.emit('MISSING_WEB_MODULE', {specifier: spec});
              return `/web_modules/${spec}.js`;
            });
          }
          await fs.mkdir(path.dirname(outPath), {recursive: true});
          await fs.writeFile(outPath, code);
        }
        if (id.startsWith('plugin:')) {
          const modulePath = require.resolve(cmd, {paths: [cwd]});
          const {build} = require(modulePath);
          try {
            var {result} = await build(f);
          } catch (err) {
            err.message = `[${id}] ${err.message}`;
            console.error(err);
            messageBus.emit('WORKER_COMPLETE', {id, error: err});
            continue;
          }
          let outPath = f.replace(config.include, distDirectoryLoc);
          const extToFind = path.extname(f).substr(1);
          const extToReplace = srcFileExtensionMapping[extToFind];
          if (extToReplace) {
            outPath = outPath.replace(new RegExp(`${extToFind}$`), extToReplace);
          }
          let code = result;
          if (path.extname(outPath) === '.js') {
            code = await transformEsmImports(code, (spec) => {
              if (spec.startsWith('http') || spec.startsWith('/')) {
                return spec;
              }
              if (spec.startsWith('./') || spec.startsWith('../')) {
                const ext = path.extname(spec).substr(1);
                if (!ext) {
                  console.error(`${f}: Import ${spec} is missing a required file extension.`);
                  return spec;
                }
                const extToReplace = srcFileExtensionMapping[ext];
                if (extToReplace) {
                  return spec.replace(new RegExp(`${ext}$`), extToReplace);
                }
                return spec;
              }
              return `/web_modules/${spec}.js`;
            });
          }
          await fs.mkdir(path.dirname(outPath), {recursive: true});
          await fs.writeFile(outPath, code);
        }
      }
      messageBus.emit('WORKER_COMPLETE', {id, error: null});
    }
  }

  await Promise.all(allWorkerPromises);

  if (isBundled) {
    messageBus.emit('WORKER_UPDATE', {id: 'bundle:*', state: ['RUNNING', 'yellow']});
    async function prepareBuildDirectoryForParcel() {
      // Prepare the new build directory by copying over all static assets
      // This is important since sometimes Parcel doesn't pick these up.
      await copy(buildDirectoryLoc, finalDirectoryLoc, {
        filter: (srcLoc) => {
          return (
            !srcLoc.startsWith(buildDirectoryLoc + path.sep + 'web_modules') &&
            !srcLoc.startsWith(buildDirectoryLoc + path.sep + config.devOptions.dist.substr(1))
          );
        },
      }).catch((err) => {
        messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'error', msg: err.toString()});
        messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: err});
        throw err;
      });
      const tempBuildManifest = JSON.parse(
        await fs.readFile(path.join(cwd, 'package.json'), {encoding: 'utf-8'}),
      );
      delete tempBuildManifest.name;
      tempBuildManifest.devDependencies = tempBuildManifest.devDependencies || {};
      tempBuildManifest.devDependencies['@babel/core'] =
        tempBuildManifest.devDependencies['@babel/core'] || '^7.9.0';
      await fs.writeFile(
        path.join(buildDirectoryLoc, 'package.json'),
        JSON.stringify(tempBuildManifest, null, 2),
      );
      await fs.writeFile(
        path.join(buildDirectoryLoc, '.babelrc'),
        `{"plugins": [["${require.resolve('@babel/plugin-syntax-import-meta')}"]]}`,
      );
    }
    await prepareBuildDirectoryForParcel();

    const bundleAppPromise = execa(
      'parcel',
      ['build', config.devOptions.fallback, '--out-dir', finalDirectoryLoc],
      {
        cwd: buildDirectoryLoc,
        env: npmRunPath.env(),
        extendEnv: true,
      },
    );
    bundleAppPromise.stdout?.on('data', (b) => {
      messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'log', msg: b.toString()});
    });
    bundleAppPromise.stderr?.on('data', (b) => {
      messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'log', msg: b.toString()});
    });
    bundleAppPromise.catch((err) => {
      messageBus.emit('WORKER_MSG', {id: 'bundle:*', level: 'error', msg: err.toString()});
      messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: err});
    });
    bundleAppPromise.then(() => {
      messageBus.emit('WORKER_COMPLETE', {id: 'bundle:*', error: null});
    });
    await bundleAppPromise;

    if (finalDirectoryLoc !== buildDirectoryLoc) {
      rimraf.sync(buildDirectoryLoc);
    }
  }
}
