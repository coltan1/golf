/**
 * tunnel.mjs — put the game on a public URL so anyone can play, from anywhere.
 *
 *   node tunnel.mjs            (serve.mjs must already be running)
 *
 * This exists because the same-wifi route is not always available. Some routers
 * run AP isolation, some put 2.4 and 5 GHz on separate subnets, and some guest
 * networks block device-to-device traffic outright — none of which is something
 * the game can fix from its side, and all of which look identical from here:
 * the server is fine, the other device simply cannot reach it.
 *
 * A tunnel sidesteps the local network completely. Both players load the same
 * public address, so it also works when the other person is not in the house.
 *
 * It uses localhost.run over SSH, which needs no account, no signup and no
 * install — Windows, macOS and Linux all ship an SSH client. Nothing here is
 * stored and no key is registered; the address is random and lasts as long as
 * this process does.
 *
 * WHAT THIS DOES, PLAINLY: while it is running, anyone who has the printed
 * address can load your game and join a match. It is a random URL, it is not
 * listed anywhere, and it dies the moment you press Ctrl+C. The server behind
 * it serves the game files and relays match messages; the screenshot endpoint
 * refuses anything that is not this machine. Close this window and you are
 * private again.
 */

import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] ?? 5177);

// Fail early and clearly if the game server is not up, rather than opening a
// tunnel to nothing and leaving someone staring at a 502.
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error(`\n  Nothing is serving on port ${PORT}.`);
  console.error('  Start the game first, in another window:\n');
  console.error('      node serve.mjs\n');
  process.exit(1);
}

console.log('\n  Opening a public address for the game…\n');

const ssh = spawn('ssh', [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=30',
  '-R', `80:localhost:${PORT}`,
  'nokey@localhost.run',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let announced = false;

function scan(chunk) {
  const text = chunk.toString();
  // The service prints a line containing the assigned https address.
  const url = /https:\/\/[^\s]+\.lhr\.life/.exec(text)?.[0]
           ?? /https:\/\/[^\s]+\.localhost\.run/.exec(text)?.[0];
  if (url && !announced) {
    announced = true;
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Play here:  ${url}`);
    console.log('  ─────────────────────────────────────────────');
    console.log('');
    console.log('  Send that to whoever you are playing. Both of you open it,');
    console.log('  then press the crossed-swords button and you will be paired.');
    console.log('');
    console.log('  Live only while this window is open. Ctrl+C ends it.');
    console.log('');
  }
}

ssh.stdout.on('data', scan);
ssh.stderr.on('data', scan);

ssh.on('error', (e) => {
  console.error('\n  Could not run ssh:', e.message);
  console.error('  Windows 10/11 ship an SSH client; if this fails, install');
  console.error('  "OpenSSH Client" from Settings > Optional Features.\n');
  process.exit(1);
});

ssh.on('close', (code) => {
  if (!announced) {
    console.error('\n  The tunnel closed before an address arrived' +
      (code ? ` (ssh exit ${code})` : '') + '.');
    console.error('  Check this machine has internet access and try again.\n');
  } else {
    console.log('\n  Tunnel closed. The game is private again.\n');
  }
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { ssh.kill(); });
}
