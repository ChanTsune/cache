import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";

import * as utils from "./internal/cacheUtils";
import { createTar, extractTar, listTar } from "./internal/tar";

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 512) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @param cacheBasePath an optional base path where cached files are stored
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    cacheBasePath?: string
): Promise<string | undefined> {
    checkPaths(paths);

    restoreKeys = restoreKeys || [];
    const keys = [primaryKey, ...restoreKeys];

    core.debug("Resolved Keys:");
    core.debug(JSON.stringify(keys));

    if (keys.length > 10) {
        throw new ValidationError(
            `Key Validation Error: Keys are limited to a maximum of 10.`
        );
    }
    for (const key of keys) {
        checkKey(key);
    }

    const compressionMethod = await utils.getCompressionMethod();
    const repoCachePath = utils.getRepoCacheStorePath(cacheBasePath);
    const cacheFileName = utils.getCacheFileName(compressionMethod);
    try {
        let archivePath = "";
        let matchedKey = "";
        const dirEntries = fs.readdirSync(repoCachePath);
        for (const key of keys) {
            const matchedCaches = dirEntries
                .filter(it => it.startsWith(key))
                .map(dir => path.join(repoCachePath, dir, cacheFileName))
                .filter(it => fs.existsSync(it))
                .map(filePath => {
                    const stats = fs.statSync(filePath);
                    return { filePath, stats };
                })
                .filter(it => it.stats.isFile())
                .sort(
                    (a, b) => b.stats.mtime.getTime() - a.stats.mtime.getTime()
                );
            const cacheFileInfo = matchedCaches.at(0);
            if (cacheFileInfo) {
                matchedKey = key;
                archivePath = cacheFileInfo.filePath;
                break;
            }
        }
        if (matchedKey === "") {
            // Cache not found
            return undefined;
        }

        core.debug(`Archive Path: ${archivePath}`);

        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }

        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        await extractTar(archivePath, compressionMethod);
        core.info("Cache restored successfully");

        return matchedKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else {
            // Supress all non-validation cache related errors because caching should be optional
            core.warning(`Failed to restore: ${(error as Error).message}`);
        }
    } finally {
        // Try to delete the archive to save space
        // try {
        //     await utils.unlinkFile(archivePath);
        // } catch (error) {
        //     core.debug(`Failed to delete archive: ${error}`);
        // }
    }

    return undefined;
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @param cacheBasePath an optional base path where cached files are stored
 * @returns true if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(
    paths: string[],
    key: string,
    cacheBasePath?: string
): Promise<number> {
    checkPaths(paths);
    checkKey(key);

    const compressionMethod = await utils.getCompressionMethod();

    const cachePaths = await utils.resolvePaths(paths);
    core.debug("Cache Paths:");
    core.debug(`${JSON.stringify(cachePaths)}`);

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    const archiveFolder = await utils.createTempDirectory();
    const archivePath = path.join(
        archiveFolder,
        utils.getCacheFileName(compressionMethod)
    );

    core.debug(`Archive Path: ${archivePath}`);

    try {
        await createTar(archiveFolder, cachePaths, compressionMethod);
        if (core.isDebug()) {
            await listTar(archivePath, compressionMethod);
        }
        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.debug(`File Size: ${archiveFileSize}`);

        core.debug(`Saving Cache (Key: ${key})`);

        const cacheStorePath = path.join(
            utils.getRepoCacheStorePath(cacheBasePath),
            key
        );
        core.debug(`Cache Store Path: ${cacheBasePath}`);
        await utils.storeCacheFile(archivePath, cacheStorePath);

        return 1;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            core.warning(`Failed to save: ${typedError.message}`);
        }
        return -1;
    } finally {
        // Try to delete the archive to save space
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }
}
