// Windows does not deliver POSIX SIGTERM through child.kill(). Exercise the same
// registered signal handler through IPC, allowing a normal exit and database close.
process.on('message', message => {
  if (message === 'shutdown') {
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.disconnect();
  }
});
await import('../../src/server.mjs');
