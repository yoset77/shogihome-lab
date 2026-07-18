import { spawn } from 'child_process';
import net from 'net';
import readline from 'readline';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createShutdownCoordinator, hasChildProcessExited, shouldCreateProcessGroup, terminateProcessTree } from './shutdown-coordinator.mjs';

// Find .env file in the same directory as this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.BIND_ADDRESS || '127.0.0.1';
const PORT = parseInt(process.env.LISTEN_PORT || '4082', 10);
const ACCESS_TOKEN = process.env.WRAPPER_ACCESS_TOKEN;

/**
 * Load engine list from engines.json.
 */
function getEngineList() {
  const enginesJsonPath = path.join(__dirname, 'engines.json');
  let engines = [];

  if (fs.existsSync(enginesJsonPath)) {
    try {
      const content = fs.readFileSync(enginesJsonPath, 'utf-8');
      engines = JSON.parse(content);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Failed to parse engines.json: ${e.message}`);
    }
  } else {
    console.error(`[${new Date().toISOString()}] engines.json not found at ${enginesJsonPath}. No engines available.`);
  }

  return engines;
}

/**
 * Apply engine options from engines.json configuration.
 * Sends setoption commands before 'isready'.
 */
function applyEngineOptions(engineProcess, options) {
  if (!options || typeof options !== 'object') {
    return;
  }

  for (let [name, value] of Object.entries(options)) {
    // Normalize boolean values to lowercase 'true'/'false' for USI compatibility
    if (typeof value === 'boolean') {
      value = value.toString();
    }

    // Sanitize: reject names/values containing line terminators
    const nameStr = String(name);
    const valueStr = String(value);

    if (nameStr.includes('\n') || nameStr.includes('\r') || valueStr.includes('\n') || valueStr.includes('\r')) {
      console.warn(`[${new Date().toISOString()}] Skipping option with invalid characters: ${nameStr}`);
      continue;
    }

    const command = `setoption name ${nameStr} value ${valueStr}`;
    console.log(`[${new Date().toISOString()}] Applying option: ${command}`);

    if (engineProcess && engineProcess.stdin && engineProcess.stdin.writable) {
      try {
        engineProcess.stdin.write(command + '\n', (err) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] Failed to write option '${name}': ${err.message}`);
          }
        });
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Exception writing option '${name}': ${e.message}`);
      }
    } else {
      console.warn(`[${new Date().toISOString()}] Cannot apply option '${name}': stdin not writable`);
    }
  }
}

const server = net.createServer((socket) => {
  console.log(`[${new Date().toISOString()}] Client connected.`);
  let engineProcess = null;
  let cleanupPromise = null;
  let unregisterEngineProcess = null;
  let unregisterCleanup = null;
  let rl = null;
  let optionsApplied = false; // Track if options have been applied
  let authenticated = !ACCESS_TOKEN; // If no token set, auth is not required
  let engineStarted = false; // Track if engine process is running
  let authNonce = null;

  const cleanup = () => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = new Promise((resolve) => {
      let quitTimeout = null;
      let termTimeout = null;
      let finished = false;
      let terminationStarted = false;

      const finishCleanup = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (quitTimeout !== null) {
          clearTimeout(quitTimeout);
        }
        if (termTimeout !== null) {
          clearTimeout(termTimeout);
        }
        if (!socket.destroyed) {
          socket.destroy();
        }
        unregisterCleanup?.();
        resolve();
      };

      rl?.close();

      const processToCleanup = engineProcess;
      const completeProcessCleanup = () => {
        unregisterEngineProcess?.();
        unregisterEngineProcess = null;
        finishCleanup();
      };
      const terminateAndFinish = (signal, failureMessage) => {
        let terminated = false;
        void terminateProcessTree(processToCleanup, signal)
          .then(() => {
            terminated = true;
          })
          .catch((error) => {
            console.error(`[${new Date().toISOString()}] ${failureMessage}`, error);
          })
          .finally(() => {
            if (terminated) {
              unregisterEngineProcess?.();
              unregisterEngineProcess = null;
            }
            finishCleanup();
          });
      };

      if (!processToCleanup) {
        engineStarted = false;
        finishCleanup();
        return;
      }
      if (hasChildProcessExited(processToCleanup)) {
        engineProcess = null;
        engineStarted = false;
        if (!socket.destroyed) {
          console.log(`[${new Date().toISOString()}] Closing client socket.`);
        }
        if (shouldCreateProcessGroup()) {
          terminateAndFinish('SIGKILL', 'Failed to clean up remaining engine process group.');
        } else {
          completeProcessCleanup();
        }
        return;
      }

      console.log(`[${new Date().toISOString()}] Cleaning up engine process (PID: ${processToCleanup.pid}).`);

      processToCleanup.once('close', (code) => {
        console.log(`[${new Date().toISOString()}] Engine process exited with code ${code}.`);
        if (engineProcess === processToCleanup) {
          engineProcess = null;
        }
        engineStarted = false;
        if (!terminationStarted) {
          if (shouldCreateProcessGroup()) {
            terminateAndFinish('SIGKILL', 'Failed to clean up remaining engine process group.');
          } else {
            completeProcessCleanup();
          }
        }
      });

      quitTimeout = setTimeout(() => {
        terminationStarted = true;
        console.warn(`[${new Date().toISOString()}] Engine did not exit after 'quit'. Terminating.`);
        const firstSignal = shouldCreateProcessGroup() ? 'SIGTERM' : 'SIGKILL';
        if (!shouldCreateProcessGroup()) {
          terminateAndFinish(firstSignal, 'Failed to terminate engine process tree.');
          return;
        }
        void terminateProcessTree(processToCleanup, firstSignal).catch((error) => {
          console.error(`[${new Date().toISOString()}] Failed to terminate engine process tree.`, error);
        });

        termTimeout = setTimeout(() => {
          console.warn(`[${new Date().toISOString()}] Engine did not respond to SIGTERM. Killing.`);
          terminateAndFinish('SIGKILL', 'Failed to kill engine process tree.');
        }, 3000);
      }, 5000);

      try {
        if (processToCleanup.stdin && processToCleanup.stdin.writable) {
          console.log(`[${new Date().toISOString()}] Sending 'quit' command to engine.`);
          processToCleanup.stdin.write('quit\n');
          processToCleanup.stdin.end();
        }
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Failed to send 'quit' command, proceeding to terminate.`, e.message);
      }
    });

    return cleanupPromise;
  };

  unregisterCleanup = shutdownCoordinator.trackCleanup(cleanup);

  if (!authenticated) {
    authNonce = crypto.randomBytes(16).toString('hex');
    socket.write(`auth_cram_sha256 ${authNonce}\n`);
  }

  rl = readline.createInterface({ input: socket });

  rl.on('line', (line) => {
    // If engine is started, forward everything to it
    if (engineStarted) {
      if (engineProcess && engineProcess.stdin.writable) {
        const command = line;
        const cmd = command.trim();

        // Inject options immediately BEFORE 'isready' command (only once)
        if (cmd === 'isready' && !optionsApplied && socket.engineOptions) {
          console.log(`[${new Date().toISOString()}] Detected 'isready', applying engine options...`);
          applyEngineOptions(engineProcess, socket.engineOptions);
          optionsApplied = true;
        }

        console.log(`[Client -> Engine] ${cmd}`);
        engineProcess.stdin.write(cmd + '\n');
      }
      return;
    }

    const input = line.trim();

    if (!authenticated) {
      if (input.startsWith('auth ')) {
        const digest = input.substring(5).trim();
        const expectedDigest = crypto.createHmac('sha256', ACCESS_TOKEN).update(authNonce).digest('hex');
        const digestBuffer = Buffer.from(digest, 'hex');
        const expectedDigestBuffer = Buffer.from(expectedDigest, 'hex');

        // Check length first to avoid RangeError in timingSafeEqual (DoS protection)
        // Then use timing-safe comparison to prevent timing attacks
        if (digestBuffer.length === expectedDigestBuffer.length && crypto.timingSafeEqual(digestBuffer, expectedDigestBuffer)) {
          console.log(`[${new Date().toISOString()}] Client authenticated successfully.`);
          authenticated = true;
          socket.write('auth_ok\n');
          return;
        } else {
          console.warn(`[${new Date().toISOString()}] Authentication failed.`);
          socket.write('WRAPPER_ERROR: Authentication failed\n', () => socket.destroy());
        }
      } else {
        console.warn(`[${new Date().toISOString()}] Unauthenticated command attempt: ${input}`);
        socket.write('WRAPPER_ERROR: Authentication required\n', () => socket.destroy());
      }

      // Stop processing any further input immediately
      if (rl) {
        rl.close();
        rl.removeAllListeners();
      }
      return;
    }

    // Engine started check again just in case (though we checked at top)
    if (engineStarted) {
      // Logic moved to top of listener
      return;
    }

    console.log(`[${new Date().toISOString()}] Received command: '${input}'`);

    const engines = getEngineList();

    if (input === 'list') {
      const listResponse = JSON.stringify(engines);
      socket.write(listResponse + '\n');
      socket.end();
      return;
    }

    let engineId = '';
    if (input.startsWith('run ')) {
      engineId = input.substring(4).trim();
    } else if (input === 'research' || input === 'game') {
      // Backward compatibility
      engineId = input;
    } else {
      console.error(`[${new Date().toISOString()}] Invalid command received: ${input}`);
      socket.write(`WRAPPER_ERROR: Invalid command. Use 'list' or 'run <id>'.\n`);
      cleanup();
      return;
    }

    const engineDef = engines.find((e) => e.id === engineId);
    if (!engineDef) {
      console.error(`[${new Date().toISOString()}] Engine ID '${engineId}' not found.`);
      socket.write(`WRAPPER_ERROR: Engine ID '${engineId}' not found.\n`);
      cleanup();
      return;
    }

    let enginePath = engineDef.path;
    if (!enginePath) {
      console.error(`[${new Date().toISOString()}] Engine path for ID '${engineId}' is not set.`);
      socket.write(`WRAPPER_ERROR: Engine path configuration error.\n`);
      cleanup();
      return;
    }

    // Resolve relative paths relative to the script directory to ensure 'cwd' is absolute and correct
    if (!path.isAbsolute(enginePath)) {
      enginePath = path.resolve(__dirname, enginePath);
    }

    const engineDirectory = path.dirname(enginePath);

    // On Windows, batch files (.bat, .cmd) must be spawned with shell: true
    const isBatchFile = process.platform === 'win32' && /\.(bat|cmd)$/i.test(enginePath);
    const spawnOptions = {
      cwd: engineDirectory,
      detached: shouldCreateProcessGroup(),
    };
    let command = enginePath;
    if (isBatchFile) {
      spawnOptions.shell = true;
      // Quote the path to handle spaces when shell: true is used
      command = `"${enginePath}"`;
    }

    engineProcess = spawn(command, [], spawnOptions);
    unregisterEngineProcess = shutdownCoordinator.trackProcess(engineProcess);

    engineProcess.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] Failed to start engine process. ${err.message}`);
      // Differentiate specific errors if needed for logs, but keep client message generic
      let clientMsg = 'WRAPPER_ERROR: Failed to start engine process.';
      if (err.code === 'ENOENT') {
        clientMsg = 'WRAPPER_ERROR: Engine executable not found.';
      }
      socket.write(clientMsg + '\n');
      cleanup();
    });

    // If the process fails to start, the 'error' event will be emitted and handled above.
    // We should not proceed if the process is not valid.
    if (engineProcess.pid === undefined) {
      return;
    }

    // Store options for the upper scope listener to use
    socket.engineOptions = engineDef.options;

    const engineName = engineDef.name || 'Unknown';
    const shortId = engineId.substring(0, 5);
    console.log(`[${new Date().toISOString()}] Started engine: ${engineName} (ID: ${shortId}...) Path: ${enginePath} (PID: ${engineProcess.pid})`);
    engineStarted = true;

    const setupPipe = (stream, prefix, isError = false) => {
      let remainder = Buffer.alloc(0);

      const processLine = (lineBytes) => {
        let lineStr;
        try {
          // Try UTF-8 first
          const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
          lineStr = utf8Decoder.decode(lineBytes);
        } catch (e) {
          try {
            // Fallback to Shift-JIS (CP932)
            const sjisDecoder = new TextDecoder('shift_jis');
            lineStr = sjisDecoder.decode(lineBytes);
          } catch (e2) {
            // Final fallback
            lineStr = lineBytes.toString('utf-8');
          }
        }

        const output = lineStr.trim();
        if (isError) {
          console.error(`${prefix} ${output}`);
        } else if (!output.startsWith('info')) {
          console.log(`${prefix} ${output}`);
        }

        if (socket.writable) {
          // Always send as UTF-8 to the client
          socket.write(Buffer.from(lineStr, 'utf-8'));
        }
      };

      stream.on('data', (chunk) => {
        remainder = Buffer.concat([remainder, chunk]);
        let lineEnd;
        while ((lineEnd = remainder.indexOf(10)) !== -1) {
          const lineBytes = remainder.subarray(0, lineEnd + 1);
          remainder = remainder.subarray(lineEnd + 1);
          processLine(lineBytes);
        }
      });

      stream.on('end', () => {
        if (remainder.length > 0) {
          processLine(remainder);
          remainder = Buffer.alloc(0);
        }
      });
    };

    setupPipe(engineProcess.stdout, '[Engine -> Client]');
    setupPipe(engineProcess.stderr, '[Engine ERROR]', true);

    engineProcess.on('close', (code) => {
      console.log(`[${new Date().toISOString()}] Engine process exited with code ${code}.`);
      engineStarted = false;
      // Ensure socket is closed when engine exits
      cleanup();
    });
  });

  socket.on('end', () => {
    console.log(`[${new Date().toISOString()}] Client sent FIN packet.`);
    cleanup();
  });

  socket.on('close', () => {
    console.log(`[${new Date().toISOString()}] Client disconnected.`);
    cleanup();
  });

  socket.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] Socket error:`, err);
    cleanup();
  });
});

const shutdownCoordinator = createShutdownCoordinator({ server });

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] Single-port engine wrapper server listening on ${HOST}:${PORT}`);

  const enginesJsonPath = path.join(__dirname, 'engines.json');
  if (fs.existsSync(enginesJsonPath)) {
    console.log(`[${new Date().toISOString()}] engines.json found at ${enginesJsonPath}`);
    try {
      const content = fs.readFileSync(enginesJsonPath, 'utf-8');
      const engines = JSON.parse(content);
      console.log(`[${new Date().toISOString()}] Loaded ${engines.length} engines from engines.json:`);
      engines.forEach((e) => console.log(`  - ${e.id}: ${e.name} (${e.path})`));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Failed to parse engines.json: ${e.message}`);
    }
  } else {
    console.error(`[${new Date().toISOString()}] engines.json not found. Please create one based on engines.json.example.`);
  }
});

let shutdownPromise = null;

const gracefulShutdown = (signal) => {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  console.log(`[${new Date().toISOString()}] Received ${signal}. Shutting down gracefully.`);
  shutdownPromise = shutdownCoordinator.shutdown().then(
    ({ forced }) => {
      if (forced) {
        console.error(`[${new Date().toISOString()}] Could not close connections in time, forcefully shutting down.`);
        process.exit(1);
      } else {
        console.log(`[${new Date().toISOString()}] All connections and engine processes closed. Server is shut down.`);
        process.exit(0);
      }
    },
    (error) => {
      console.error(`[${new Date().toISOString()}] Failed to shut down cleanly.`, error);
      process.exit(1);
    },
  );
  return shutdownPromise;
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
