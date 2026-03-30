/**
 * Test fixture: hanging oracle — never exits (for timeout testing).
 */
await Bun.stdin.text(); // consume stdin
// Hang forever
await new Promise(() => {});
