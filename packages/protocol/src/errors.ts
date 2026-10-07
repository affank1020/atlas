// Stable application error codes; transports retain their existing response mapping.
export class AtlasError extends Error { constructor(message: string, readonly code = "INVALID_REQUEST") { super(message); } }
