var Q = require('q');
var fs = require('fs-extra');
var os = require('os');
var _ = require('lodash');
var path = require('path');
var childProcess = require('child_process');

var tags = require('./tags');
var config = require('./config');

var IS_WINDOWS = process.platform === 'win32';

// Locate the npm CLI shipped with the running node,
// rather than whichever "npm" comes first in the PATH (e.g. node_modules/.bin/npm)
var findNPM = _.memoize(function() {
    var nodeDir = path.dirname(process.execPath);
    var npmCli = _.find([
        path.resolve(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
        path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')
    ], function(file) {
        return fs.existsSync(file);
    });

    if (npmCli) return { bin: process.execPath, args: [npmCli] };
    return { bin: IS_WINDOWS? 'npm.cmd' : 'npm', args: [] };
});

// Run the npm CLI and return its stdout
// The programmatic npm API has been removed, so we spawn the npm CLI instead
function runNPM(args, cwd) {
    var d = Q.defer();
    var npm = findNPM();

    childProcess.execFile(npm.bin, npm.args.concat(args, ['--loglevel=error']), {
        cwd: cwd,
        maxBuffer: 50 * 1024 * 1024,
        // Spawning .cmd files on Windows requires a shell
        shell: IS_WINDOWS && !npm.args.length
    }, function(err, stdout, stderr) {
        if (err) {
            err.message = 'npm ' + args[0] + ' failed: ' + (stderr || err.message);
            return d.reject(err);
        }
        d.resolve(stdout);
    });

    return d.promise;
}

// Return a list of versions available in the registry (npm)
function availableVersions() {
    return runNPM(['view', 'gitbook', 'versions', 'dist-tags', '--json'])
    .then(function(stdout) {
        var result = JSON.parse(stdout);
        result = {
            versions: _.chain(result.versions)
                .filter(function(v) {
                    return tags.isValid(v);
                })
                .sort(tags.sort)
                .value(),
            tags: _.pickBy(result['dist-tags'], function(tagVersion) {
                return tags.isValid(tagVersion);
            })
        };

        if (result.versions.length == 0) throw new Error('No valid version on the NPM registry');
        return result;
    });
}

// Resolve a version name or tag to an installable absolute version
function resolveVersion(version) {
    var _version = version;

    return availableVersions()
    .then(function(available) {
        // Resolve if tag
        if (available.tags[version]) version = available.tags[version];

        version = _.find(available.versions, function(v) {
            return tags.satisfies(v, version, {
                // Tag is resolved from npm dist-tags
                acceptTagCondition: false
            });
        });

        // Check version
        if (!version) throw new Error('Invalid version or tag "'+_version+'", see available using "gitbook ls-remote"');
        return version;
    });
}

// Install a specific version of gitbook
function installVersion(version) {
    var tmpDir;

    return resolveVersion(version)
    .then(function(_version) {
        version = _version;
        return Q.nfcall(fs.mkdtemp, path.join(os.tmpdir(), 'gitbook-'));
    })
    .then(function(_tmpDir) {
        tmpDir = _tmpDir;
        console.log('Installing GitBook', version);

        // "shallow" keeps gitbook's dependencies nested in its own folder,
        // so the folder can be copied on its own
        return runNPM([
            'install', 'gitbook@' + version,
            '--prefix', '.',
            '--install-strategy=shallow',
            '--no-save', '--no-package-lock', '--no-audit', '--no-fund'
        ], tmpDir);
    })
    .then(function() {
        var gitbookRoot = path.resolve(tmpDir, 'node_modules/gitbook');
        var packageJson = fs.readJsonSync(path.resolve(gitbookRoot, 'package.json'));
        var version = packageJson.version;

        var outputFolder = path.resolve(config.VERSIONS_ROOT, version);

        if (!tags.isValid(version)) throw new Error('Invalid GitBook version, should satisfies '+config.GITBOOK_VERSION);

        // Copy to the install folder
        return Q(fs.copy(gitbookRoot, outputFolder))
        .thenResolve(version);
    })
    .fin(function() {
        if (tmpDir) return Q(fs.remove(tmpDir));
    });
}

module.exports = {
    versions: availableVersions,
    resolve: resolveVersion,
    install: installVersion
};
