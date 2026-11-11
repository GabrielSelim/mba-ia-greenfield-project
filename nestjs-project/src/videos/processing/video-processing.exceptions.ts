/**
 * Worker-side errors (not HTTP — never reach the domain exception filter).
 * `InvalidVideoMediaException` and `SourceObjectMissingException` are
 * permanent: the processor turns them into BullMQ `UnrecoverableError`s.
 */

/** stderr fragments that mean "the input is not a readable media file". */
const INVALID_INPUT_PATTERNS = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /could not find codec parameters/i,
  /does not contain any stream/i,
];

/** ffprobe/ffmpeg exited with an error, timed out or could not start. */
export class MediaToolException extends Error {
  readonly invalidInput: boolean;

  constructor(
    public readonly tool: string,
    public readonly detail: string,
  ) {
    super(`${tool} failed: ${detail}`);
    this.name = 'MediaToolException';
    this.invalidInput = INVALID_INPUT_PATTERNS.some((pattern) =>
      pattern.test(detail),
    );
  }
}

export class InvalidVideoMediaException extends Error {
  constructor(reason: string) {
    super(`Uploaded file is not a playable video: ${reason}`);
    this.name = 'InvalidVideoMediaException';
  }
}

export class SourceObjectMissingException extends Error {
  constructor(storageKey: string) {
    super(`Source object ${storageKey} not found in storage`);
    this.name = 'SourceObjectMissingException';
  }
}
