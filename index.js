const cp = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

let winapi;
try {
  winapi = require('winapi-bindings');
} catch (err) {}

async function createIPC(usePipe, id, onExit, onStdout, containerName) {
  // it does actually get named .exe on linux as well
  const exeName = 'ModInstallerIPC.exe';

  let cwd = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'dist');
  let exePath = path.join(cwd, exeName);

  const args = [id];
  if (usePipe) {
    args.push('--pipe');
  }

  if ((winapi !== undefined)
      && (winapi?.SupportsAppContainer?.() === true)
      && (containerName !== undefined)) {
    return new Promise((resolve, reject) => {
      // in case the container wasn't cleaned up before
      try {
        winapi.DeleteAppContainer(containerName);
        winapi.CreateAppContainer(containerName, 'FOMOD', 'Container for fomod installers');
        process.on('exit', () => {
          winapi.DeleteAppContainer(containerName);
        });
        try {
          const files = fs.readdirSync(cwd);
          for (const f of files) {
            winapi.GrantAppContainer(containerName, path.join(cwd, f), 'file_object', ['generic_read', 'read_ea', 'read_attributes']);
          }
        } catch (err) {
          console.log('failed to grant access', err);
          const newCWD = path.join(os.tmpdir(), containerName);
          try {
            fs.removeSync(newCWD);
          } catch (err) {}
          fs.copySync(cwd, newCWD);
          cwd = newCWD;
          exePath = path.join(newCWD, exeName);
          winapi.GrantAppContainer(containerName, cwd, 'file_object', ['generic_read', 'read_ea', 'read_attributes', 'list_directory']);
          const files = fs.readdirSync(cwd);
          for (const f of files) {
            winapi.GrantAppContainer(containerName, path.join(cwd, f), 'file_object', ['generic_read', 'read_ea', 'read_attributes']);
          }
        }
        winapi.GrantAppContainer(containerName, `\\\\?\\pipe\\${id}`, 'named_pipe', ['all_access']);
        winapi.GrantAppContainer(containerName, `\\\\?\\pipe\\${id}_reply`, 'named_pipe', ['all_access']);

        try {
          const pid = winapi.RunInContainer(containerName, `${exePath} ${args.join(' ')}`, cwd, onExit, onStdout);
          resolve(pid);
        } catch (err) {
          // I think this may be caused by an AV scanning the files after we copied them
          setTimeout(() => {
            try {
              const pid = winapi.RunInContainer(containerName, `${exePath} ${args.join(' ')}`, cwd, onExit, onStdout);
              resolve(pid);
            } catch (err) {
              reject(err);
            }
          }, 1000);
        }
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(path.join(__dirname, 'dist', exeName), args)
        .on('error', err => {
          reject?.(err);
          resolve = reject = undefined;
        })
        .on('exit', (code, signal) => {
          if (code === 0x80131700) {
            reject?.(new Error('No compatible .Net Framework, you need .Net framework 4.6 or newer'));
          } else if (code !== null) {
            reject?.(new Error(`Failed to run fomod installer. Errorcode ${code.toString(16)}`));
          } else {
            reject?.(new Error(`The fomod installer was terminated. Signal: ${signal}`));
          }
          resolve = reject = undefined;
          onExit(code);
        });

      proc.stdout.on('data', dat => dat.toString());
      proc.stderr.on('data', dat => dat.toString());

      // resolve slightly delayed to allow the error event to be triggered if the process fails to
      // start. Unfortunately cp.spawn seems to flip a coin on whether it reports events at all or not.
      setTimeout(() => {
        if ((proc.exitCode !== null) && (proc.exitCode !== 0)) {
          reject?.(new Error('Failed to spawn fomod installer'));
        } else {
          resolve?.(proc.pid);
        }
        resolve = reject = undefined;
      }, 100);
    });
  }
}

module.exports = {
  __esModule: true,
  createIPC,
};
