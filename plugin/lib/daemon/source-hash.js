/**
 * The daemon's source hash: the identity of what a build of the package directory produces, so the plugin page can
 * tell whether the installed app (its Info.plist CUSourceHash, written by scripts/build-app.sh) is this package's.
 * The commit in CFBundleVersion cannot tell that: a dirty tree, a tarball without git and a plugin-only commit all
 * read wrong.
 *
 * Shared contract with scripts/source-hash.sh (the two must give identical output): the files are "Package.swift",
 * every regular file under "Sources/" (recursive; symbolic links are neither followed nor listed) excluding files
 * named ".DS_Store", and "scripts/build-app.sh" (it decides what the app is beyond its code: the Info.plist keys, the
 * bundle id, how it is signed; a package without it has no source hash); each path is relative to the package root
 * with "/" separators; the paths are sorted by plain byte order (LC_ALL=C sort); each file contributes one line
 * "<relative path>\t<lowercase hex sha256 of its bytes>\n"; the source hash is the lowercase hex sha256 of the
 * concatenation of those lines (UTF-8). The shell script prints it followed by a newline; this module returns the 64
 * hex characters alone.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** The one file outside Sources/ besides Package.swift that the hash covers. */
export const BUILD_SCRIPT = 'scripts/build-app.sh';
/** The files the hash covers, relative to root, in hash order. */
export function sourceHashFiles(root) {
    const files = ['Package.swift', BUILD_SCRIPT];
    const walk = (rel) => {
        for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
            const path = `${rel}/${entry.name}`;
            if (entry.isDirectory())
                walk(path);
            else if (entry.isFile() && entry.name !== '.DS_Store')
                files.push(path);
        }
    };
    walk('Sources');
    return files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}
/** The source hash of the package at root; throws when Package.swift, Sources/ or scripts/build-app.sh cannot be read. */
export function sourceHash(root) {
    const lines = sourceHashFiles(root).map((rel) => `${rel}\t${createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')}\n`);
    return createHash('sha256').update(lines.join(''), 'utf8').digest('hex');
}
