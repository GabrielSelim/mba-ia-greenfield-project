/**
 * The storage refused to assemble a multipart upload from the part list the
 * client reported (missing part, wrong ETag, part too small, unknown upload).
 * Infrastructure-level: callers translate it into their own domain error.
 */
export class StorageUploadRejectedException extends Error {
  constructor(
    public readonly storageCode: string,
    message: string,
  ) {
    super(`Storage rejected the multipart upload (${storageCode}): ${message}`);
    this.name = 'StorageUploadRejectedException';
  }
}
