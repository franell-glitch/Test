#!/usr/bin/env node
// Ersatz für rclone in Tests: "onedrive:Ordner/Datei" wird auf FAKE_REMOTE_DIR abgebildet
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const [cmd, ...args] = process.argv.slice(2);
const remoteDir = process.env.FAKE_REMOTE_DIR;
const toLocal = (remote) => path.join(remoteDir, remote.replace(/^onedrive:/, ''));
if (process.env.FAKE_RCLONE_FAIL) {
  console.error('Failed to copy: token expired');
  process.exit(1);
}
if (cmd === 'copyto') {
  const dest = toLocal(args[1]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(args[0], dest);
} else if (cmd === 'delete') {
  fs.appendFileSync(path.join(remoteDir, 'deletes.log'), args.join(' ') + '\n');
} else {
  process.exit(2);
}
