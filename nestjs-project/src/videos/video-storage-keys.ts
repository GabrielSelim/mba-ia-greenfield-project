/** Object storage layout (technical-decisions-phase-03-videos TD-03). */
export function originalVideoKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
