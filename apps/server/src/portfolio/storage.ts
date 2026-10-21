/** Compatibility exports for Portfolio while it adopts the shared Atlas object-store adapter. */
export {
    LocalObjectStore as LocalMediaObjectStore,
    R2ObjectStore as R2MediaObjectStore,
    R2WithLocalFallback,
    ObjectNotFound as MediaObjectNotFound,
    createObjectStore as createMediaObjectStore,
} from "../server/file-storage.js";
export type {
    ObjectStore as MediaObjectStore,
    R2StorageConfig as R2MediaConfig,
} from "../server/file-storage.js";
