/** The server has a Daytona credential. Kept apart from the client so pages can check it cheaply. */
export function daytonaConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY?.trim());
}
