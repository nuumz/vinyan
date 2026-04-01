/**
 * Test fixture: bad-output oracle — returns invalid JSON.
 */
await Bun.stdin.text();
process.stdout.write('this is not json\n');
